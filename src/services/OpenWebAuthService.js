/**
 * OpenWebAuth (FEP-61cf) — de TARGET-kant.
 *
 * Waarom dit bestaat: `fan_only` betekent "mijn volgers op de fediverse", maar
 * de poort vroeg om een KLONKT-ACCOUNT. Dat is de verkeerde vraag: precies de
 * mensen voor wie de poort openstaat -- volgers elders -- konden er niet door,
 * en wie er wel door kon had meestal niets met volgen te maken. Hiermee kan een
 * bezoeker bewijzen dat hij @iemand@ergens is, zonder hier een account, een
 * wachtwoord of een cookie van een derde partij.
 *
 * WIJ ZIJN DE TARGET INSTANCE, nooit de home instance. Dat is de prettige helft:
 * de home instance heeft de prive-sleutel nodig (om te ondertekenen en om ons
 * token te ontsleutelen), wij hebben alleen publieke sleutels nodig. Er staat
 * hier dus geen geheim van iemand anders, en we kunnen ook niemands identiteit
 * uitgeven. Het spiegelbeeld (Klonkt-gebruikers laten inloggen OP andere sites,
 * de /magic-kant) is bewust NIET gebouwd: dat is een andere functie.
 *
 * De stroom, met de FEP-stappen erbij:
 *   1. bezoeker geeft zijn adres        -> wij webfingeren hem, vinden zijn
 *                                          redirect-endpoint, sturen hem daarheen
 *   2. zijn server controleert hem      -> en vraagt ONS om een token
 *   3. wij verifieren die ondertekende  -> token terug, versleuteld met ZIJN
 *      aanvraag                            publieke sleutel
 *   4. zijn server ontsleutelt          -> stuurt hem terug met ?owt=<token>
 *   5. wij wisselen het token in        -> nu weten we wie hij is
 *
 * DRIE DINGEN DIE DE FEP ALS AANVAL BESCHRIJFT, en die hieronder staan omdat ze
 * anders precies de fout worden die je niet ziet:
 *
 *  - IMPERSONATIE. `?zid=` mag NOOIT iemands identiteit bepalen; alleen het
 *    ingewisselde `?owt=` telt. Mallory kan een link maken met zid=bob@elders,
 *    en komt dan terug met een token dat MALLORY zegt. Wie zid gelooft, laat
 *    Mallory als Bob binnen.
 *  - OPEN REDIRECT. Het redirect-endpoint dat we uit webfinger halen moet
 *    dezelfde host hebben als het adres dat de bezoeker intypte, anders sturen
 *    wij bezoekers naar waar een vreemde maar wil.
 *  - DoS. Tokens vervallen in minuten en gaan na een keer gebruiken weg.
 */
import crypto from 'crypto';
import db from '../config/database.js';

/** Kort, want tussen stap 3 en 5 zit alleen een redirect. De FEP noemt "a couple of minutes". */
export const TOKEN_TTL_MS = 3 * 60 * 1000;

/** rel-waarden uit de FEP. Letterlijk, want hier hangt de vindbaarheid aan. */
export const REL_TOKEN = 'http://purl.org/openwebauth/v1';
export const REL_REDIRECT = 'http://purl.org/openwebauth/v1#redirect';

// ── tokens ────────────────────────────────────────────────────────────────

/** Alles wat over tijd is weg. Draait bij elke uitgifte en elke inwisseling. */
export function sweepTokens(now = Date.now()) {
  db.prepare('DELETE FROM owa_tokens WHERE created_at < ?').run(now - TOKEN_TTL_MS);
}

/**
 * Stap 3: een token voor deze actor, opgeslagen zodat we hem straks herkennen.
 * URL-veilig, want hij reist als query-parameter terug.
 */
export function issueToken(actorUri, now = Date.now()) {
  sweepTokens(now);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO owa_tokens (token, actor_uri, created_at) VALUES (?,?,?)')
    .run(token, String(actorUri), now);
  return token;
}

/**
 * Stap 5: eenmalig inwisselen. Geeft de actor terug, of null.
 *
 * Het verwijderen gebeurt ALTIJD, ook als het token te oud bleek: een token dat
 * eenmaal is aangeboden mag nooit een tweede kans krijgen.
 */
export function redeemToken(token, now = Date.now()) {
  const t = String(token || '');
  if (!t) return null;
  const row = db.prepare('SELECT actor_uri, created_at FROM owa_tokens WHERE token = ?').get(t);
  if (row) db.prepare('DELETE FROM owa_tokens WHERE token = ?').run(t);
  sweepTokens(now);
  if (!row) return null;
  if (now - row.created_at > TOKEN_TTL_MS) return null;
  return row.actor_uri;
}

/**
 * Het token versleuteld met de PUBLIEKE sleutel van de actor, zodat alleen zijn
 * server het kan lezen. PKCS#1 v1.5 en base64url zonder '=' staan zo in de FEP;
 * dat is geen smaak maar interop met Hubzilla en (streams).
 */
export function encryptTokenFor(token, publicKeyPem) {
  const buf = crypto.publicEncrypt(
    { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(token), 'utf8'),
  );
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── ontdekken waar de bezoeker vandaan komt ───────────────────────────────

/** `@iemand@ergens.nl`, `iemand@ergens.nl`, `acct:iemand@ergens.nl` -> {user, host}. */
export function parseHandle(input) {
  const m = String(input || '').trim().replace(/^acct:/i, '').replace(/^@/, '')
    .match(/^([^@\s/]+)@([^@\s/]+)$/);
  if (!m) return null;
  const host = m[2].toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null;
  return { user: m[1], host, acct: `${m[1]}@${host}` };
}

/**
 * Stap 1: waar stuurt deze bezoeker zich heen om zich te bewijzen?
 *
 * De FEP: nieuwe implementaties horen te webfingeren, oude hard-coden /magic.
 * We doen het eerste en vallen terug op het tweede -- die terugval is veilig
 * omdat hij per constructie op DEZELFDE host ligt.
 *
 * En hier staat de open-redirect-controle: wat webfinger ook teruggeeft, het
 * moet de host zijn van het adres dat de bezoeker zelf intypte. Zonder die
 * regel wordt dit formulier een doorgeefluik naar elke gewenste URL.
 */
export async function discoverRedirectEndpoint(handle, { fetchImpl = fetch } = {}) {
  const h = parseHandle(handle);
  if (!h) return null;
  const url = `https://${h.host}/.well-known/webfinger?resource=${encodeURIComponent('acct:' + h.acct)}`;
  let href = null;
  try {
    const r = await fetchImpl(url, { headers: { accept: 'application/jrd+json, application/json' } });
    if (r.ok) {
      const jrd = await r.json();
      const link = (jrd.links || []).find((l) => l && l.rel === REL_REDIRECT && l.href);
      if (link) href = link.href;
    }
  } catch { /* geen webfinger: hieronder de terugval */ }
  if (!href) href = `https://${h.host}/magic`;
  try {
    if (new URL(href).host.toLowerCase() !== h.host) return null;   // open redirect
  } catch { return null; }
  return { endpoint: href, handle: h };
}

/** `bdest`: de terugkeer-URL als hex, zo staat het in de FEP. */
export function toBdest(url) {
  return Buffer.from(String(url), 'utf8').toString('hex');
}

/**
 * De URL waar we de bezoeker heen sturen.
 *
 * De terugkeer-URL moet BINNEN onze eigen origin liggen -- en het liefst binnen
 * de PWA-scope (siteUrlBase), anders komt iemand die de site op zijn
 * beginscherm heeft na het inloggen terecht in een losse browsertab terwijl de
 * app uitgelogd blijft. Dat ziet eruit als "inloggen werkt niet" en is het niet.
 */
export function buildRedirect(endpoint, returnUrl) {
  const u = new URL(endpoint);
  u.searchParams.set('owa', '1');
  u.searchParams.set('bdest', toBdest(returnUrl));
  return u.toString();
}

// ── de HOME-kant: onze gebruiker bewijst zich elders ──────────────────────
//
// Hier zijn de rollen omgedraaid. Wij hebben nu de prive-sleutel nodig -- om te
// ondertekenen en om het token te ontsleutelen -- en dat is precies waarom
// alleen een echte instance deze kant kan spelen.

/** `bdest` terug naar een URL. Hex in, URL uit; ongeldig = null. */
export function fromBdest(hex) {
  const h = String(hex || '');
  if (!/^[0-9a-f]+$/i.test(h) || h.length % 2) return null;
  try {
    const u = new URL(Buffer.from(h, 'hex').toString('utf8'));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u;
  } catch { return null; }
}

/**
 * Het token-endpoint van de doelsite, gevonden via webfinger op zijn WORTEL.
 *
 * En meteen de open-redirect-verdediging van deze kant: het gevonden endpoint
 * moet dezelfde origin hebben als `bdest`. De FEP zegt het met zoveel woorden --
 * lukt de ontdekking niet, of wijst hij ergens anders heen, dan sturen we de
 * browser NIET naar bdest maar geven we een fout. Anders is /magic het
 * doorgeefluik.
 */
export async function discoverTokenEndpoint(bdestUrl, { fetchImpl = fetch } = {}) {
  let origin;
  try { origin = new URL(bdestUrl).origin; } catch { return null; }
  const url = `${origin}/.well-known/webfinger?resource=${encodeURIComponent(origin + '/')}`;
  try {
    const r = await fetchImpl(url, { headers: { accept: 'application/jrd+json, application/json' } });
    if (!r.ok) return null;
    const jrd = await r.json();
    const link = (jrd.links || []).find((l) => l && l.rel === REL_TOKEN && l.href);
    if (!link) return null;
    if (new URL(link.href).origin !== origin) return null;   // open redirect
    return link.href;
  } catch { return null; }
}

/**
 * Het token ophalen bij de doelsite, ondertekend namens onze actor.
 *
 * De handtekening gaat in `Authorization: Signature ...` -- zo schrijft de FEP
 * het voor, en niet in de `Signature`-header die de rest van de fediverse
 * gebruikt. Plus `X-Open-Web-Auth` met willekeur erin: de doelsite doet er
 * niets mee, het voegt alleen entropie toe aan wat we ondertekenen.
 */
export async function requestToken(endpoint, { keyId, privatePem, fetchImpl = fetch } = {}) {
  const u = new URL(endpoint);
  const date = new Date().toUTCString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const target = `${u.pathname}${u.search || ''}`;
  const signingString = [
    `(request-target): get ${target}`,
    `host: ${u.host}`,
    `date: ${date}`,
    `x-open-web-auth: ${nonce}`,
  ].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(signingString), privatePem).toString('base64');
  const headers = {
    Accept: 'application/json',
    Date: date,
    'X-Open-Web-Auth': nonce,
    Authorization: `Signature keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date x-open-web-auth",signature="${signature}"`,
  };
  const r = await fetchImpl(endpoint, { headers });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || j.success !== true || !j.encrypted_token) return null;
  return String(j.encrypted_token);
}

/** Het token uitpakken met onze eigen prive-sleutel. */
export function decryptToken(encrypted, privatePem) {
  const b64 = String(encrypted || '').replace(/-/g, '+').replace(/_/g, '/');
  const buf = crypto.privateDecrypt(
    { key: privatePem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(b64, 'base64'),
  );
  const t = buf.toString('utf8');
  // Een token is URL-veilige tekst. Bij een verkeerde sleutel geeft PKCS#1 v1.5
  // geen fout maar afgeleide onzin terug (implicit rejection, zie de toelichting
  // bij encryptTokenFor), en die onzin hoort hier te stranden in plaats van als
  // token de wereld in te gaan.
  //
  // ALLEBEI de voorwaarden doen werk, en dat is gemeten met 300 vreemde sleutels:
  //  - de TEKENSET vangt vrijwel alles. Van die 300 was er geen enkele die
  //    volledig uit URL-veilige tekens bestond.
  //  - de ONDERGRENS vangt de rest. De onzin heeft een willekeurige lengte (5
  //    tot 209 bytes gezien), en 18 van de 300 was korter dan 16 bytes. Bij zo'n
  //    kort stukje is "toevallig allemaal URL-veilig" niet meer verwaarloosbaar:
  //    per byte is die kans ruwweg een kwart.
  // Zestien is daarmee geen rond getal maar een grens die iets doet. Een echte
  // implementatie zit er ruim boven (de onze: 43 tekens).
  return /^[A-Za-z0-9._~-]{16,512}$/.test(t) ? t : null;
}

// ── wie is er binnen ──────────────────────────────────────────────────────

/** De actor die deze sessie bewees te zijn, of null. */
export function guestActor(req) {
  const g = req && req.session && req.session.owa;
  return (g && typeof g.actor === 'string' && g.actor) ? g.actor : null;
}

/** Volgt deze actor deze site? Dat is de vraag die `fan_only` altijd al stelde. */
export function isFollowerOf(slug, actorUri) {
  if (!slug || !actorUri) return false;
  const row = db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND actor_uri = ? LIMIT 1')
    .get(String(slug), String(actorUri));
  return !!row;
}

/**
 * Alles wat een poort over deze bezoeker moet weten, op één plek.
 *
 * Bewust hier en niet in PostAccessService: die module beslist en raakt de
 * database niet aan. Deze haalt op, die beslist.
 */
export function viewerFor(req, site, extra = {}) {
  const actor = guestActor(req);
  return {
    user: (req && req.session && req.session.user) || null,
    site: site || null,
    fediActor: actor,
    isFollower: actor && site ? isFollowerOf(site.slug, actor) : false,
    ...extra,
  };
}

export default {
  TOKEN_TTL_MS, REL_TOKEN, REL_REDIRECT,
  sweepTokens, issueToken, redeemToken, encryptTokenFor,
  parseHandle, discoverRedirectEndpoint, toBdest, buildRedirect,
  guestActor, isFollowerOf, viewerFor,
  fromBdest, discoverTokenEndpoint, requestToken, decryptToken,
};
