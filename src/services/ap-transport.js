/**
 * ap-transport.js — het transport onder de federatie (stap 3 van shaer-drc).
 *
 * Alles wat hier woont raakt het netwerk of de sleutels, en niets erin weet
 * iets van Notes, feeds of guardianship:
 *   - de SSRF-poort (safeFetch en zijn wachters) voor ELKE uitgaande fetch
 *   - de RSA-sleutels per actor
 *   - HTTP Signatures: tekenen (deliver, signedGetHeaders) en controleren
 *     (verifyRequest)
 *   - de bezorging met wachtrij en backoff (deliverWithRetry en de worker)
 *   - de ondertekende GET (signedGetJson) en zijn onbetekende broer (apGetJson)
 *
 * Verhuisd uit ActivityPubService.js, dat alles her-exporteert: bestaande
 * importeurs merken niets. De afhankelijkheden wijzen alleen omlaag (db,
 * ap-core, Node zelf) -- er mag hier nooit iets uit de dienstlaag bij.
 */
import crypto from 'crypto';
import fs from 'fs';
import dns from 'dns';
import net from 'net';
import db from '../config/database.js';
import { actorId } from './ap-core.js';

// ── SSRF guard for outbound fetches ───────────────────────────────
// Remote URLs (actor/keyId/webfinger/inbox/inReplyTo) are attacker-controlled, so
// every outbound fetch must refuse hosts that resolve to private/loopback ranges
// (cloud metadata, internal services) — on the initial host AND each redirect hop.
function isBlockedIp(ip) {
  if (!ip) return true;
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    return o[0] === 127 || o[0] === 10 || o[0] === 0
      || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
      || (o[0] === 192 && o[1] === 168)
      || (o[0] === 169 && o[1] === 254)
      || (o[0] === 100 && o[1] >= 64 && o[1] <= 127); // CGNAT
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80')
      || s.startsWith('::ffff:127.') || s.startsWith('::ffff:10.') || s.startsWith('::ffff:192.168.')
      || s.startsWith('::ffff:169.254.') || s.startsWith('::ffff:172.');
  }
  return true; // not an IP literal we recognise → refuse
}
/**
 * Uitzonderingen op de SSRF-poort, voor een testkudde op de eigen machine
 * (shaer-6wt: honderd wards met een guardian, Barts opdracht 8-8).
 *
 * WAAROM DIT MAG BESTAAN. De bescherming hierboven is er omdat een actor-URI van
 * een VREEMDE komt: een aanvaller die "http://169.254.169.254/" doorgeeft laat
 * ons zijn werk doen. Deze lijst gaat niet over vreemden -- hij staat in de
 * omgeving van deze server, wordt door de beheerder gezet, en is leeg tenzij
 * iemand hem expliciet vult.
 *
 * WAAROM HIJ ZO SMAL IS. Geen vlag die "loopback is oke" zegt, maar een lijst
 * van precieze host:poort-paren. `[::1]:3060` opent niet 127.0.0.1, niet poort
 * 3061, en niets in het interne netwerk. Een brede vlag zou de bescherming in
 * een dev-omgeving uitzetten, en dev-omgevingen worden productie.
 *
 *   AP_ALLOW_HOSTS="[::1]:3060,[::1]:3061"
 */
const AP_ALLOW_HOSTS = new Set(
  String(process.env.AP_ALLOW_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
);
function isAllowedTestHost(u) {
  if (!AP_ALLOW_HOSTS.size) return false;
  return AP_ALLOW_HOSTS.has(u.host.toLowerCase());
}
async function assertPublicHost(hostname) {
  // URL.hostname geeft een IPv6-literal MET blokhaken ("[::1]"), en net.isIP
  // herkent die vorm niet. Zonder strippen viel elk IPv6-adres door naar de
  // DNS-tak, waar het strandde op ENOTFOUND: geweigerd, maar per ongeluk en met
  // de verkeerde reden. isBlockedIp strippde ze al -- die verwachtte dus input
  // die hier nooit aankwam.
  const naakt = String(hostname || '').replace(/^\[|\]$/g, '');
  if (net.isIP(naakt)) { if (isBlockedIp(naakt)) throw new Error('ssrf-blocked-ip'); return; }
  const addrs = await dns.promises.lookup(naakt, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) throw new Error('ssrf-blocked-host');
}
// One honest name on ALL outbound federation traffic (Robins vraag, 31-7):
// safeFetch went out with the bare Node default before, and polite fediverse
// citizens say who they are (some instances even refuse anonymous UAs). A
// caller-provided User-Agent (the EmbedResolver) still wins.
let _uaVer = '1.0';
try { _uaVer = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url))).version || _uaVer; } catch { /* keep default */ }
const KLONKT_UA = `Klonkt/${_uaVer} (+https://klonkt.com)`;

export async function safeFetch(url, opts = {}, maxRedirects = 3) {
  let target = url;
  for (let hop = 0; ; hop++) {
    const u = new URL(target); // throws on malformed → caller's catch
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('ssrf-bad-scheme');
    // Alleen op de precieze host:poort uit AP_ALLOW_HOSTS, en per hop opnieuw:
    // een omleiding naar een ANDER intern adres blijft geweigerd.
    if (!isAllowedTestHost(u)) await assertPublicHost(u.hostname);
    const r = await fetch(target, {
      ...opts,
      headers: { 'User-Agent': KLONKT_UA, ...(opts.headers || {}) },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const loc = (r.status >= 300 && r.status < 400) ? r.headers.get('location') : null;
    if (loc && hop < maxRedirects) { target = new URL(loc, target).toString(); continue; }
    return r;
  }
}

// ── RSA keys per actor (lazy, cached in DB) ───────────────────────
// Prepared lazily (NOT at module load) — the ap_keys table is created in
// initializeDatabase(), which runs after this module is imported.
let _sel, _ins;
function keyStmts() {
  if (!_sel) {
    _sel = db.prepare('SELECT public_pem, private_pem FROM ap_keys WHERE slug = ?');
    _ins = db.prepare('INSERT OR IGNORE INTO ap_keys (slug, public_pem, private_pem, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)');
  }
  return { sel: _sel, ins: _ins };
}

export function getOrCreateKeys(slug) {
  const { sel, ins } = keyStmts();
  const row = sel.get(slug);
  if (row) return row;
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  ins.run(slug, publicKey, privateKey);
  return sel.get(slug) || { public_pem: publicKey, private_pem: privateKey };
}

// ── HTTP Signatures + delivery ────────────────────────────────────
// Sign + POST an activity to a remote inbox (draft-cavage HTTP Signatures, RSA-SHA256).
export async function deliver(inboxUrl, bodyObj, keyId, privatePem) {
  const body = JSON.stringify(bodyObj);
  const u = new URL(inboxUrl);
  const date = new Date().toUTCString();
  const digest = 'SHA-256=' + crypto.createHash('sha256').update(body).digest('base64');
  const signingString = `(request-target): post ${u.pathname}\nhost: ${u.host}\ndate: ${date}\ndigest: ${digest}`;
  const signature = crypto.sign('sha256', Buffer.from(signingString), privatePem).toString('base64');
  const sig = `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`;
  const r = await safeFetch(inboxUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/activity+json', Accept: 'application/activity+json', Date: date, Digest: digest, Signature: sig },
    body,
  });
  return r.status;
}

export async function fetchActor(url, opts = {}) {
  // Authorized fetch (Mastodons secure mode): zo'n instance serveert zijn
  // actor-document -- en dus zijn publieke sleutel -- alleen aan een ONDERTEKEND
  // verzoek en antwoordt anders met 401. Zonder sleutel kunnen we een correct
  // ondertekende Follow van die instance niet verifiëren en wijzen we hem af,
  // waarna Mastodon het dagenlang blijft proberen. Gemeten op boiert.eu: vier
  // accounts eindeloos geweigerd, en precies die vier geven 401 op een
  // onbetekende GET (shaer-afq).
  //
  // Geen kip-ei: om ONZE handtekening te controleren haalt de andere kant ons
  // actor-document op, en dat serveert Klonkt publiek.
  //
  // ONBETEKEND EERST, en dat is een veiligheidskeuze en geen optimalisatie.
  // verifyRequest haalt de keyId-URL op VOORDAT er iets geverifieerd is, en die
  // URL komt uit een header die iedereen mag sturen. Tekenden we dat verzoek
  // standaard, dan kan een volslagen onbekende ons een ONDERTEKEND verzoek laten
  // sturen naar een adres van zijn keuze -- met onze identiteit eronder. Dat is
  // precies hoe een instance op een blocklist belandt. Ondertekenen doen we dus
  // pas als het onbetekend niet lukt, en dan alleen voor deze ene URL.
  let doc = null;
  try {
    const r = await safeFetch(url, { headers: { Accept: 'application/activity+json' } });
    if (r.ok) {
      const len = Number(r.headers.get('content-length') || 0);
      if (len > 2_000_000) return null; // refuse oversized actor docs
      doc = await r.json();
    }
  } catch { /* val door naar de ondertekende poging */ }
  // Genoeg? Dan klaar. Sommige instances serveren onbetekend wel een document
  // maar zonder sleutel; voor een verificatie hebben we daar niets aan, dus die
  // telt als mislukt.
  if (doc && (!opts.asSlug || (doc.publicKey && doc.publicKey.publicKeyPem))) return doc;
  if (!opts.asSlug) return doc;
  const signed = await signedGetJson(opts.asSlug, url).catch(() => null);
  return (signed && signed.id) ? signed : doc;
}

// ── Delivery queue with retries ───────────────────────────────────
// Outbound deliveries are tried immediately; on failure (down server, timeout,
// non-2xx) they're queued and retried with backoff so a briefly-offline follower
// doesn't silently miss the post. The signing key is NOT stored — the worker
// re-derives it from the actor slug at send time.
//
// KLONKT DIE NIET ALTIJD AAN STAAT (shaer-xzab). Een Klonkt op een Mac thuis
// slaapt, gaat de trein in, staat een weekend uit. Daarom:
//
//  - Een bezorging VERLOOPT OP LEEFTIJD (5 dagen sinds created_at), niet na een
//    aantal pogingen (xzab.1). Zes pogingen waren ~4,5 uur, en de laatste trede
//    van 360 minuten werd nooit gebruikt: de telling was er eerder.
//  - OFFLINE ZIJN KOST GEEN POGINGEN (xzab.2). Mislukt een hele beurt op
//    netwerkniveau, naar meer dan één server en zonder één HTTP-antwoord, dan
//    ligt het aan ons: alles een paar minuten opschuiven, de telling ongemoeid,
//    en niets laten verlopen. Slapen kost al niets, want dan loopt de timer niet.
//  - BACKOFF PER SERVER, VOLGORDE PER INBOX (xzab.3). Eén mislukking naar een
//    server schuift al zijn rijen op. En per inbox oudste eerst, ook bij het
//    directe versturen: bij een venster van dagen mag een herhaalde Create niet
//    NA de Delete van dezelfde post aankomen.
const DELIVERY_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
// Minuten tot de volgende poging, op de poging die net mislukte; de laatste
// trede herhaalt tot de bezorging verloopt.
const DELIVERY_BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720, 1440];
// Hoe ver een beurt opschuift als WIJ offline blijken.
const OFFLINE_RETRY_MIN = 2;

export function deliveryBackoffMinutes(attemptsSoFar) {
  return DELIVERY_BACKOFF_MIN[Math.min(Math.max(0, attemptsSoFar), DELIVERY_BACKOFF_MIN.length - 1)];
}

/** De host (met poort) van een inbox, in kleine letters; null als het geen URL is. */
export function inboxHost(inbox) {
  try { return new URL(inbox).host.toLowerCase(); } catch { return null; }
}

/** Is een bezorging zo oud dat hij opgegeven wordt? created_at is SQLite-UTC
 *  ('YYYY-MM-DD HH:MM:SS', zonder zone). */
export function deliveryExpired(createdAt, now = Date.now()) {
  if (!createdAt) return false;
  const t = Date.parse(String(createdAt).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(createdAt) ? '' : 'Z'));
  return Number.isFinite(t) && now - t >= DELIVERY_MAX_AGE_MS;
}

/** Faalde dit op NETWERKNIVEAU (geen HTTP-antwoord)? Een SSRF-weigering is
 *  dat niet: die is een besluit, en blijft een besluit als we weer online zijn. */
function isNetworkError(e) {
  return !/^ssrf/.test(String((e && e.message) || ''));
}

let _insDeliv, _dueDeliv, _delDeliv, _bumpDeliv, _hostDeliv, _offDeliv, _pendInbox, _hostWaits;
function deliveryStmts() {
  if (!_insDeliv) {
    _insDeliv = db.prepare('INSERT INTO ap_delivery (slug, inbox, host, body, attempts, next_at) VALUES (?,?,?,?,0,CURRENT_TIMESTAMP)');
    // Alleen de OUDSTE openstaande rij per inbox: een nieuwere wacht op hem, ook
    // als hij zelf al aan de beurt zou zijn. Op id, want dat is de volgorde
    // waarin ze ontstonden.
    _dueDeliv = db.prepare(`SELECT d.* FROM ap_delivery d
      WHERE datetime(d.next_at) <= datetime('now')
        AND NOT EXISTS (SELECT 1 FROM ap_delivery o WHERE o.inbox = d.inbox AND o.id < d.id)
      ORDER BY d.id LIMIT 30`);
    _delDeliv = db.prepare('DELETE FROM ap_delivery WHERE id = ?');
    _bumpDeliv = db.prepare('UPDATE ap_delivery SET attempts = ?, next_at = ? WHERE id = ?');
    // Een server die faalde: al zijn rijen niet eerder dan de nieuwe poging.
    _hostDeliv = db.prepare('UPDATE ap_delivery SET next_at = ? WHERE host = ? AND datetime(next_at) < datetime(?)');
    // Wij offline: opschuiven, de telling ongemoeid.
    _offDeliv = db.prepare('UPDATE ap_delivery SET next_at = ? WHERE id = ?');
    _pendInbox = db.prepare('SELECT 1 FROM ap_delivery WHERE inbox = ? LIMIT 1');
    _hostWaits = db.prepare("SELECT 1 FROM ap_delivery WHERE host = ? AND datetime(next_at) > datetime('now') LIMIT 1");
  }
  return { ins: _insDeliv, due: _dueDeliv, del: _delDeliv, bump: _bumpDeliv, host: _hostDeliv, off: _offDeliv, pendInbox: _pendInbox, hostWaits: _hostWaits };
}
export function enqueueDelivery(slug, inbox, activity) {
  if (!slug || !inbox || !activity) return;
  try { deliveryStmts().ins.run(slug, inbox, inboxHost(inbox), JSON.stringify(activity)); } catch { /* ignore */ }
}
// Record delivery health per follower so the followers list can flag dead accounts.
// Keyed by inbox: a shared-inbox POST reaches every follower behind it, so all of them
// are marked. A non-follower inbox (inline @mention) simply matches 0 rows.
let _fDelivOk, _fDelivErr;
function markFollowerDelivery(slug, inbox, ok) {
  if (!slug || !inbox) return;
  try {
    if (!_fDelivOk) {
      _fDelivOk = db.prepare('UPDATE ap_followers SET last_delivery_at = CURRENT_TIMESTAMP WHERE slug = ? AND (inbox = ? OR shared_inbox = ?)');
      _fDelivErr = db.prepare('UPDATE ap_followers SET last_error_at = CURRENT_TIMESTAMP WHERE slug = ? AND (inbox = ? OR shared_inbox = ?)');
    }
    (ok ? _fDelivOk : _fDelivErr).run(slug, inbox, inbox);
  } catch { /* health tracking is non-fatal */ }
}
// Deliver now, or queue: zegt welke van de twee het werd ('sent' | 'queued'),
// voor de aanroepers die tellen wat er meteen aankwam.
//
// Niet meteen als er voor deze inbox al iets in de wachtrij staat (dan zou dit
// er voorbij gaan: een Delete vóór de Create die nog wacht), en niet als deze
// server net faalde en in zijn backoff zit (dan kost het alleen acht seconden
// time-out om hetzelfde te horen). Dan achteraan in de rij.
//
// DE ENIGE WEG om iets direct te versturen dat bij een mislukking in de rij
// hoort (shaer-xzab.3). Drie plekken deden eerst zelf deliver() en pas bij een
// mislukking enqueueDelivery(), en gingen zo langs de volgorde per inbox.
export async function deliverNowOrQueue(slug, inbox, activity, keyId, privPem) {
  if (!inbox) return 'queued';
  try {
    const st = deliveryStmts();
    if (st.pendInbox.get(inbox) || st.hostWaits.get(inboxHost(inbox))) { enqueueDelivery(slug, inbox, activity); return 'queued'; }
  } catch { /* geen wachtrij te lezen: gewoon proberen */ }
  try { const st = await deliver(inbox, activity, keyId, privPem); if (st >= 200 && st < 300) { markFollowerDelivery(slug, inbox, true); return 'sent'; } } catch { /* queue below */ }
  enqueueDelivery(slug, inbox, activity);
  return 'queued';
}
// Deliver now; queue for retry if it fails.
export async function deliverWithRetry(slug, inbox, activity, keyId, privPem) {
  await deliverNowOrQueue(slug, inbox, activity, keyId, privPem);
}
let _processingDeliv = false;
export async function processDeliveryQueue() {
  if (_processingDeliv) return; // re-entrancy guard: 30 rows × 8s can exceed the 60s tick → no double-delivery
  _processingDeliv = true;
  try {
    let rows;
    try { rows = deliveryStmts().due.all(); } catch { return; }
    if (!rows || !rows.length) return;
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    // Eerst alles proberen, pas daarna beslissen: of het aan ons lag, zie je
    // pas aan de hele beurt.
    const failed = [];          // { row, network }
    const down = new Set();     // servers die in deze beurt al faalden
    const skipped = [];         // rijen van zo'n server, niet meer geprobeerd
    let answered = false;       // kwam er ergens een HTTP-antwoord?
    for (const row of rows) {
      const host = row.host || inboxHost(row.inbox);
      if (host && down.has(host)) { skipped.push(row); continue; }
      let ok = false, network = false;
      try {
        const keys = getOrCreateKeys(row.slug);
        const st = await deliver(row.inbox, JSON.parse(row.body), `${actorId(base, row.slug)}#main-key`, keys.private_pem);
        answered = true;
        ok = st >= 200 && st < 300;
      } catch (e) { network = isNetworkError(e); }
      if (ok) { markFollowerDelivery(row.slug, row.inbox, true); deliveryStmts().del.run(row.id); continue; }
      failed.push({ row, network, host });
      if (host) down.add(host);
    }
    if (!failed.length) return;

    // Lag het aan ons? Niets beantwoord, alles op netwerkniveau, en naar meer
    // dan één server -- bij één server is "hij ligt eruit" net zo waarschijnlijk.
    const hosts = new Set(failed.map((f) => f.host));
    const offline = !answered && failed.every((f) => f.network) && hosts.size > 1;
    if (offline) {
      const later = new Date(Date.now() + OFFLINE_RETRY_MIN * 60000).toISOString();
      for (const r of [...failed.map((f) => f.row), ...skipped]) deliveryStmts().off.run(later, r.id);
      console.warn('[AP] delivery: no network for', failed.length, 'deliveries to', hosts.size, 'servers; retrying in', OFFLINE_RETRY_MIN, 'min, attempts untouched');
      return;
    }

    for (const { row, host } of failed) {
      if (deliveryExpired(row.created_at)) {
        markFollowerDelivery(row.slug, row.inbox, false);
        deliveryStmts().del.run(row.id);
        console.warn('[AP] delivery gave up after', row.attempts + 1, 'tries over 5 days →', row.inbox);
        continue;
      }
      const next = new Date(Date.now() + deliveryBackoffMinutes(row.attempts) * 60000).toISOString();
      deliveryStmts().bump.run(row.attempts + 1, next, row.id);
      // De hele server wacht mee: zijn andere rijen niet eerder dan deze.
      if (host) deliveryStmts().host.run(next, host, next);
    }
  } finally { _processingDeliv = false; }
}
let _delivTimer = null;
export function startDeliveryWorker() {
  if (_delivTimer) return;
  _delivTimer = setInterval(() => { processDeliveryQueue().catch(() => {}); }, 60 * 1000);
  if (_delivTimer.unref) _delivTimer.unref();
}

/** Een lokale site om GETs mee te ondertekenen wanneer er geen specifieke is
 *  (de gedeelde inbox). Gecached: dit draait per binnenkomend verzoek. */
let _signSlug;
export function anySigningSlug() {
  if (_signSlug !== undefined) return _signSlug;
  try { const r = db.prepare('SELECT slug FROM sites ORDER BY rowid LIMIT 1').get(); _signSlug = (r && r.slug) || null; }
  catch { _signSlug = null; }
  return _signSlug;
}

// Best-effort verification of an incoming signed request. Returns the sender's
// actor doc if the signature checks out, else null. (Not gating yet — MVP.)
// Max clock skew for the signed Date header (replay window). Generous default to tolerate
// federating servers with drifting clocks; an operator can widen it via env.
const SIG_MAX_SKEW_MS = (Number(process.env.AP_SIG_MAX_SKEW_MIN) || 60) * 60 * 1000;
export async function verifyRequest(req, asSlug = null) {
  const sigH = req.headers['signature'];
  if (!sigH) return null;
  const p = Object.fromEntries([...sigH.matchAll(/([a-zA-Z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
  if (!p.keyId || !p.signature) return null;
  // Onderteken de sleutel-ophaal, anders faalt elke instance met authorized
  // fetch (shaer-afq). Zonder aangewezen site -- de gedeelde inbox -- tekenen we
  // als een willekeurige lokale actor: elke Klonkt-actor is een geldige
  // ondertekenaar, het gaat de andere kant er alleen om DAT er ondertekend is.
  const actor = await fetchActor(p.keyId.split('#')[0], { asSlug: asSlug || anySigningSlug() });
  const pem = actor && actor.publicKey && actor.publicKey.publicKeyPem;
  if (!pem) return null;
  // Bind the key to the actor it speaks for. Without this we hand back whatever
  // `id` the fetched document claims, so anyone could host a document carrying a
  // VICTIM's id next to their OWN public key, sign with their own private half,
  // and be believed: the victim's server is never contacted. The caller decides on
  // `verified.id`, so the identity has to come from where the key was FETCHED,
  // never from what the document says about itself.
  // Adds conditions only, and there is no exemption list on purpose: an
  // "unless it's a known peer" escape hatch is exactly the door this closes.
  // Note this does not narrow what we accept in practice, since the line above
  // already requires the embedded publicKey object (an array or a bare URI
  // reference never worked here).
  const key = actor.publicKey;
  try {
    if (new URL(p.keyId).host !== new URL(actor.id).host) return null;   // same origin as the key
    if (key.id && key.id !== p.keyId) return null;                       // this key, not a neighbour's
    if (key.owner && key.owner !== actor.id) return null;                // and it belongs to this actor
  } catch { return null; }                                               // unparseable id or keyId
  const hs = (p.headers || '(request-target) host date').split(/\s+/);
  // Behind a reverse proxy the raw Host header is the backend bind (e.g. localhost:3000, when
  // the proxy doesn't preserve it — Apache .htaccess [P] proxying), but the sender signed the
  // HTTP-Signature over the PUBLIC host. Try each candidate host (the configured PUBLIC_BASE_URL
  // host, the proxy's X-Forwarded-Host, and the raw Host) and accept if the signature verifies
  // against any. An attacker can't forge a match (no private key), so this only rescues the
  // legitimate proxied case. Also normalise a leading double-slash in the request-target.
  let _pubHost = null;
  if (process.env.PUBLIC_BASE_URL) { try { _pubHost = new URL(process.env.PUBLIC_BASE_URL).host; } catch { /* ignore */ } }
  const _hosts = [...new Set([_pubHost, req.headers['x-forwarded-host'], req.headers['host']].filter(Boolean))];
  const _target = `${req.method.toLowerCase()} ${String(req.originalUrl || '').replace(/^\/{2,}/, '/')}`;
  const _sig = Buffer.from(p.signature, 'base64');
  let ok = false;
  for (const _h of _hosts) {
    const line = hs.map((x) => x === '(request-target)'
      ? `(request-target): ${_target}`
      : x === 'host' ? `host: ${_h}`
      : `${x}: ${req.headers[x] || ''}`).join('\n');
    try { if (crypto.verify('sha256', Buffer.from(line), pem, _sig)) { ok = true; break; } } catch { /* try next host */ }
  }
  // Replay defence: the Date header must be signed and recent. A captured signed request
  // replayed later (or with a swapped body) is rejected.
  if (ok) {
    if (!hs.includes('date')) ok = false;
    else {
      const t = Date.parse(req.headers['date'] || '');
      if (isNaN(t) || Math.abs(Date.now() - t) > SIG_MAX_SKEW_MS) ok = false;
    }
  }
  // Digest is MANDATORY when the request carries a body: without a signed digest the body
  // isn't covered by the signature and could be swapped on a replay.
  if (ok && req.rawBody && req.rawBody.length) {
    if (!hs.includes('digest')) ok = false;
    else {
      const exp = 'SHA-256=' + crypto.createHash('sha256').update(req.rawBody).digest('base64');
      if (req.headers['digest'] !== exp) ok = false;
    }
  }
  return ok ? actor : null;
}

// A generic SSRF-safe AP GET (collections / pages).
/**
 * A signed GET as one of our local actors (friends-history, 30-7): the remote
 * server can then recognise the caller and serve what THAT caller may see,
 * exactly like the guardian's authorized fetch. The signature covers
 * (request-target) host date, the set verifyRequest checks.
 */
/**
 * De handtekening-headers voor een GET als `slug`. Losgetrokken uit
 * signedGetJson omdat een verhuizing ook BYTES moet kunnen ophalen (FEP-1580:
 * gehoste audio zit achter dezelfde poort als de rest, en een ongetekende fetch
 * krijgt daar terecht een 403).
 */
export function signedGetHeaders(slug, url, accept = 'application/activity+json') {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !slug) return null;
  const me = actorId(base, slug);
  const keys = getOrCreateKeys(slug);
  const u = new URL(url);
  const date = new Date().toUTCString();
  const target = `${u.pathname}${u.search || ''}`;
  const signingString = `(request-target): get ${target}\nhost: ${u.host}\ndate: ${date}`;
  const signature = crypto.sign('sha256', Buffer.from(signingString), keys.private_pem).toString('base64');
  return {
    Accept: accept,
    Date: date,
    Signature: `keyId="${me}#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
  };
}

export async function signedGetJson(slug, url, onStatus) {
  try {
    const headers = signedGetHeaders(slug, url);
    if (!headers) return apGetJson(url);
    const r = await safeFetch(url, { headers });
    // De status doorgeven aan wie erom vroeg: null alleen zegt "het lukte
    // niet", en dat is te weinig om een WEIGERING van een STORING te
    // onderscheiden. Wie geen callback meegeeft merkt hier niets van.
    if (typeof onStatus === 'function') onStatus(r.status);
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 3_000_000) return null;
    return await r.json();
  } catch { return null; }
}

export async function apGetJson(url) {
  try {
    const r = await safeFetch(url, { headers: { Accept: 'application/activity+json' } });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 3_000_000) return null;
    return await r.json();
  } catch { return null; }
}
