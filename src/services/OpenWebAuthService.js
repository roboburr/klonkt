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
};
