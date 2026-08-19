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

/**
 * Een deterministische nep-uitkomst, afgeleid uit de ciphertext en onze eigen
 * sleutel. Dit is de kern van implicit rejection: bij ongeldige padding geven we
 * GEEN fout maar een waarde, zodat "klopte de padding" nergens af te lezen is.
 *
 * DETERMINISTISCH, en dat is geen detail. Zou dit verse willekeur zijn, dan
 * geeft dezelfde ciphertext twee keer aanbieden twee verschillende antwoorden --
 * en juist dat verschil is het onderscheid dat we wilden verbergen. Zo doen TLS
 * en OpenSSL 3.2 het ook: afgeleid uit sleutel + ciphertext, dus stabiel bij
 * herhaling en onvoorspelbaar voor wie de sleutel niet heeft.
 *
 * Geëxporteerd omdat die eigenschap toetsbaar moet zijn; buiten de tests heeft
 * niemand hem nodig.
 *
 * EERLIJK OVER WAT DIT WEL EN NIET DRAAGT (gemeten 19-8): haal je hem weg, dan
 * blijft de suite groen. De andere tak geeft dan een LEGE string terug, en die
 * sneuvelt net zo goed op de tekenset-controle hieronder -- "werpt niet" en
 * "levert geen token" zijn dus al gedekt zonder deze functie. Wat hij toevoegt
 * is dat ALLE faalwegen dezelfde vorm teruggeven: verkeerde sleutel, verkeerde
 * lengte, kapotte base64, ongeldige padding. Een lege string is een verklikker
 * voor wie ooit naar de rauwe waarde kijkt in plaats van naar het eindoordeel;
 * afgeleide bytes zijn dat niet. Zo doen TLS en OpenSSL 3.2 het ook.
 */
export function _nepUitkomst(privatePem, ct) {
  const geheim = crypto.createHash('sha256').update(String(privatePem)).digest();
  return crypto.createHmac('sha256', geheim).update(ct).digest().toString('latin1');
}

/**
 * PKCS#1 v1.5 zelf uitpakken (EME-PKCS1-v1_5: 00 02 PS 00 M).
 *
 * WAAROM ZELF: Node weigert `privateDecrypt` met RSA_PKCS1_PADDING sinds de
 * mitigatie voor CVE-2023-46809 (Marvin). De revert-vlag bestaat alleen op de
 * lijnen 18/20/21 -- Node 22+ heeft hem nooit gehad, en 20 is sinds 30 april
 * 2026 EOL. Er is dus geen weg terug; zie shaer-r15.
 *
 * OpenWebAuth (FEP-61cf) schrijft v1.5 voor, dus overstappen op OAEP repareert
 * de fout en breekt de interop met Hubzilla. Blijft over: `RSA_NO_PADDING` en
 * het omhulsel er zelf afhalen -- precies het stuk dat de CVE veroorzaakte, dus
 * met de zorg die daarbij hoort.
 *
 * GEEN VROEGE UITGANG EN GEEN WORP. De scan loopt altijd het hele blok af en
 * beide takken doen hetzelfde werk. Dat is geen echte constant-time -- die
 * krijg je in JavaScript met JIT en GC niet -- maar het haalt wel het
 * waarneembare verschil weg. Wat de aanval hier echt begrenst is de teller op
 * /magic: een orakel heeft honderdduizenden pogingen nodig.
 */
function pakUit(blok, privatePem, ct) {
  const k = blok.length;
  // Kop: 00 02. Als getal uitrekenen, niet als vertakking.
  let goed = ((blok[0] === 0x00) & (blok[1] === 0x02));
  // Eerste nulbyte vanaf 2 zoeken ZONDER de lus te verlaten.
  let sep = -1;
  for (let i = 2; i < k; i++) {
    const isNul = blok[i] === 0x00 ? 1 : 0;
    const nogNiet = sep === -1 ? 1 : 0;
    sep = sep + (isNul & nogNiet) * (i - sep);
  }
  // PS moet minstens 8 bytes zijn (RFC 8017), dus de scheider ligt op >= 10.
  goed = goed & (sep >= 10 ? 1 : 0) & (sep < k ? 1 : 0);
  const echt = blok.subarray(goed ? sep + 1 : k).toString('utf8');
  const nep = _nepUitkomst(privatePem, ct);
  return goed ? echt : nep;
}

/** Het token uitpakken met onze eigen prive-sleutel. */
export function decryptToken(encrypted, privatePem) {
  const b64 = String(encrypted || '').replace(/-/g, '+').replace(/_/g, '/');
  const ct = Buffer.from(b64, 'base64');
  let k = 0;
  try { k = crypto.createPublicKey(privatePem).asymmetricKeyDetails.modulusLength / 8; } catch { k = 0; }

  // Een blok van de verkeerde lengte zegt niets over de sleutel, maar het zou
  // wel werpen -- en een worp is precies het signaal dat we kwijt willen. Dus
  // dezelfde weg als een ongeldige padding.
  let blok = null;
  if (k && ct.length === k) {
    try {
      blok = crypto.privateDecrypt({ key: privatePem, padding: crypto.constants.RSA_NO_PADDING }, ct);
    } catch { blok = null; }
  }
  const t = (blok && blok.length === k) ? pakUit(blok, privatePem, ct) : _nepUitkomst(privatePem, ct);

  // Een token is URL-veilige tekst. Wat hierboven uit een mislukking komt is
  // afgeleide onzin, en die hoort hier te stranden in plaats van als token de
  // wereld in te gaan.
  //
  // ALLEBEI de voorwaarden doen werk, en dat is gemeten met 300 vreemde sleutels:
  //  - de TEKENSET vangt vrijwel alles. Van die 300 was er geen enkele die
  //    volledig uit URL-veilige tekens bestond.
  //  - de ONDERGRENS vangt de rest. De onzin heeft een willekeurige lengte, en
  //    bij een kort stukje is "toevallig allemaal URL-veilig" niet meer
  //    verwaarloosbaar: per byte is die kans ruwweg een kwart.
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
