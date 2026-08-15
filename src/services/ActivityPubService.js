/**
 * ActivityPubService — Klonkt as a real ActivityPub actor (fediverse bridge).
 *
 * Phase 1 (this file): the PUBLISH/discoverable side.
 *   - per-site RSA keypair (Mastodon-compatible HTTP Signatures; separate from
 *     the Ed25519 keys used by the lighter Cirkels v1)
 *   - builders for the Actor document, Note objects and the Outbox collection
 *   - apWants(): HTTP content-negotiation helper (activity+json vs HTML)
 *
 * The interactive side (inbox: Follow/Accept, signature verify, delivery to
 * followers) lands in the next step and is tested live against Mastodon.
 *
 * AP actor URLs live under /ap/* so they never clash with the human pages:
 *   actor   = <base>/ap/users/<slug>
 *   inbox   = <actor>/inbox      outbox = <actor>/outbox
 *   note    = <base>/ap/notes/<postId>
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import net from 'net';
import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';
import AudioEmbedService from './AudioEmbedService.js';
import EmbedResolver from './EmbedResolver.js';
import Push from './PushService.js';
import { t as i18nT } from './i18n.js';
import Blocklist from './BlocklistService.js';
import * as Guardianship from './guardianship/index.js';
import { PUBLIC, AP_CONTEXT, safeUrl, actorId, noteId, guessMediaType, normalizeTags, tagParts, hashtagTags, buildHashtagList, pagedCollection, PAGINA_GROOTTE, artiestUrl } from './ap-core.js';
// Doorgeven wat hier altijd vandaan kwam, zodat elke bestaande aanroep blijft werken.
export { AP_CONTEXT, actorId, noteId, guessMediaType };
// De muziekkant woont in music/ (shaer-drc). Doorgeven wat hier altijd
// vandaan kwam, zodat elke bestaande aanroep blijft werken.
import { luisteraars } from './music/index.js';
import { TRACK_KOLOMMEN,
  playlistOpenTracks, siteOpenTracks, openTrack, trackHostPosts,
  buildTrackAudio, buildTrackCollection, buildTrackCreate,
  buildPlaylistCollection, listPlaylistsAP, playlistLinkTags,
  buildPostTrackCollection, uitgavePost,
  buildLibrary, libraryId,
  licentieUri, channelCategory,
} from './music/index.js';
export {
  playlistOpenTracks, siteOpenTracks, openTrack, trackHostPosts,
  buildTrackAudio, buildTrackCollection, buildTrackCreate,
  buildPlaylistCollection, listPlaylistsAP, playlistLinkTags, licentieUri,
  buildPostTrackCollection, uitgavePost,
  buildLibrary, libraryId,
};


// Short random suffix so two activity ids minted in the same millisecond (e.g.
// parallel saves) don't collide and get deduped by a receiver.
const rid = () => crypto.randomBytes(4).toString('hex');

// Keep only http(s) URLs — drops javascript:/data:/etc so a remote actor can't
// smuggle a dangerous scheme into a stored href/src (rendered in owner-only views).

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
const MAX_OUTBOX = 20;
// Cache-buster for the music listen-link → forces Mastodon to re-crawl a FRESH
// (square) player card. Bump this whenever the twitter:player card dimensions change.
const FEDI_CARD_VER = '2';

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

// ── content negotiation ───────────────────────────────────────────
// True when the caller wants ActivityPub JSON rather than the HTML page.
export function apWants(req) {
  const a = String(req.headers.accept || '').toLowerCase();
  return a.includes('application/activity+json') ||
         (a.includes('application/ld+json') && a.includes('activitystreams'));
}

const AP_CONTENT_TYPE = 'application/activity+json; charset=utf-8';
/**
 * Hetzelfde antwoord als de vorige keer? Dan 304 (Barts punt, 9-8).
 *
 * De inbox doet dit al met `since` + `wait`, en de guardian-wachtrijen niet: die
 * stuurden bij elke verversing de hele lijst terug, ook als er niets veranderd
 * was. Bij honderd wards is dat 217 KB JSON die de telefoon opnieuw moet
 * parsen -- over de lijn valt het mee (2,8 KB gzip), maar het OPBOUWEN van
 * veertienhonderd objecten is wat je merkt.
 *
 * EEN INHOUDS-ETAG, geen cursor. Een cursor vraagt een tweede beschrijving van
 * wanneer iets "veranderd" is, en die kan uit de pas gaan lopen met wat er
 * werkelijk in het antwoord staat; een hash van het antwoord zelf kan dat per
 * definitie niet. De server bouwt het antwoord nog steeds (26 ms) -- wat we
 * besparen is de overdracht en het parsen.
 *
 * NOOIT 304 OP EEN LEEG ANTWOORD. Dezelfde les als de '0'-uitzondering bij de
 * inbox: gaat er bij het opbouwen iets mis en komt er een lege lijst uit, dan is
 * die hash ook stabiel, en zou een client voor eeuwig 304 krijgen op niets.
 */
export function etagFor(body) {
  return `"${crypto.createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}

export function sendMaybe304(req, res, obj, { cacheControl, contentType } = {}) {
  const body = JSON.stringify(obj);
  const leeg = !obj || (Array.isArray(obj.orderedItems) && obj.orderedItems.length === 0);
  res.set('Vary', 'Authorization');
  if (!leeg) {
    const tag = etagFor(body);
    res.set('ETag', tag);
    if (req.headers['if-none-match'] === tag) return res.status(304).end();
  }
  res.type(contentType || AP_CONTENT_TYPE);
  // `no-cache` betekent NIET "niet bewaren": de client bewaart het antwoord en
  // vraagt elke keer of het nog klopt. Precies wat we willen -- zonder dit
  // stuurt een browser geen If-None-Match en is de ETag decoratie.
  res.set('Cache-Control', cacheControl || 'private, no-cache');
  return res.send(body);
}

export function sendAP(res, obj, cacheControl) {
  res.type(AP_CONTENT_TYPE);
  // A per-caller (e.g. guardian-widened) view must not be publicly cached.
  res.set('Cache-Control', cacheControl || 'public, max-age=120');
  res.send(JSON.stringify(obj));
}

// ── document builders ─────────────────────────────────────────────


/** Eén Link uit een AS2 `url` kiezen op mediaType. Een `url` mag een string,
 *  een Link of een array van beide zijn; dit is de enige plek die dat weet. */
function pickLink(url, test) {
  const links = Array.isArray(url) ? url : (url ? [url] : []);
  for (const l of links) {
    const href = safeUrl(typeof l === 'string' ? l : (l && l.href));
    const mt = (l && typeof l === 'object' && l.mediaType) || '';
    if (href && test(mt)) return { href, mediaType: mt };
  }
  return null;
}

/**
 * De `url` van de actor als kanaal (shaer-0nh): de webpagina en, als die er is,
 * de RSS-feed ernaast.
 *
 * De RSS-link gaat er ALLEEN in voor de site waar de instance op gepind staat.
 * Sinds hub-modus verdween serveert routes/feed.js `/feed.xml` van de primaire
 * site en bestaat `/user/<slug>` niet meer als route; een feed-link voor een
 * andere site zou naar de verkeerde feed wijzen. Liever een link minder dan een
 * link die iemand anders' muziek belooft.
 */
export function channelUrls(base, site) {
  const isPrimair = site.slug === site.primary_slug;
  const pagina = `${base}/${isPrimair ? '' : 'user/' + encodeURIComponent(site.slug)}`;
  const uit = [{ type: 'Link', href: pagina, mediaType: 'text/html' }];
  if (isPrimair) uit.push({ type: 'Link', href: `${base}/feed.xml`, mediaType: 'application/rss+xml' });
  return uit;
}


/**
 * Welke objectsoorten deze inbox in de tijdlijn opneemt.
 *
 * `Audio` staat erbij sinds de kanaalbeslissing (shaer-0nh): een Funkwhale-
 * kanaal stuurt Create(Audio), geen Note. Uitbreiden gebeurt HIER en in
 * timelineFields -- en uitdrukkelijk NIET door vreemde soorten tot Note om te
 * vormen. Een Audio is geen Note, en die soort willen we kunnen blijven zien.
 */
const TIJDLIJN_SOORTEN = new Set(['Note', 'Article', 'Question', 'Audio']);

/**
 * Wat de tijdlijn van een binnengekomen object nodig heeft, PER SOORT: de
 * inhoud-HTML, de bijlagen voor media_json, en de link van het item.
 *
 * Eén plek, zodat een nieuwe soort erbij een tak is en geen speurtocht. De
 * Krant rendert media_json al naar soort -- audio/* wordt een speler -- dus een
 * track komt vanzelf als echte speler binnen zonder dat de weergave iets van
 * Funkwhale hoeft te weten.
 */
/**
 * De waarschuwingstekst van een object, of niets.
 *
 * `summary` IS in AS2 een SAMENVATTING -- "a natural language summarization of
 * the object". Dat Mastodon dat veld hergebruikt als waarschuwing is Mastodons
 * conventie, en die zet er `sensitive` bij. Zonder `sensitive` is een summary
 * dus gewoon een samenvatting.
 *
 * WordPress + ActivityPub stuurt daar de EXCERPT van een artikel in, netjes
 * afgekapt voor Mastodon. Wij lazen dat als waarschuwing en verborgen de post
 * daarmee achter zijn eigen eerste alinea (Barts melding, 13-8:
 * europeanpirates.eu). Niemand krijgt dan te zien wat er staat, en de
 * waarschuwing waarschuwt nergens voor.
 */
export function contentWarning(o) {
  if (!o || !o.sensitive) return null;
  const s = typeof o.summary === 'string' ? o.summary.trim() : '';
  return s || null;
}

export function timelineFields(o) {
  // De hoes: een `image` op het object. Bij een Note alleen als terugval (daar
  // is het de kaart-afbeelding van een player-post), bij een Audio altijd,
  // want daar IS het de albumhoes.
  const hoes = () => {
    if (!o.image) return null;
    const im = Array.isArray(o.image) ? o.image[0] : o.image;
    const iu = safeUrl(typeof im === 'string' ? im : (im && im.url));
    return iu ? { url: iu, type: (im && im.mediaType) || 'image/jpeg' } : null;
  };

  if (o.type === 'Audio') {
    const geluid = pickLink(o.url, (mt) => /^audio\//i.test(mt));
    // De webpagina van de track. Zonder mediaType is dat de veilige aanname:
    // er een speler op zetten zou een HTML-pagina als geluid aanbieden.
    const pagina = pickLink(o.url, (mt) => /^text\/html/i.test(mt)) || pickLink(o.url, (mt) => !mt);
    const atts = [];
    const h = hoes(); if (h) atts.push(h);              // eerst kijken, dan luisteren
    if (geluid) atts.push({ url: geluid.href, type: geluid.mediaType || 'audio/mpeg' });
    // Een Audio heeft geen `content`; de titel is wat er te lezen valt. Door de
    // sanitizer, want hij komt van een vreemde server.
    return {
      html: o.name ? HtmlSanitizerService.sanitize(`<p>${o.name}</p>`) : '',
      atts,
      url: pagina ? pagina.href : null,
    };
  }

  // Een ARTIKEL heeft een titel, en die is het eerste wat je wilt zien. Zonder
  // dit kwam een WordPress-post binnen als kale body: de titel zit in `name` en
  // die gooiden we weg, terwijl de excerpt in `summary` ten onrechte als
  // waarschuwing dienstdeed. Nu allebei goed -- en dit is dezelfde greep die
  // resolveRemoteNote al doet voor niet-Note-objecten, dus de tijdlijn en het
  // antwoordpad zeggen eindelijk hetzelfde.
  if (o.type && o.type !== 'Note' && typeof o.name === 'string' && o.name.trim()) {
    const kop = `<p><strong>${HtmlSanitizerService.escape ? HtmlSanitizerService.escape(o.name) : o.name}</strong></p>`;
    const atts = mediaFromNote(o);
    const pagina = pickLink(o.url, (mt) => !mt || /html/i.test(mt));
    return {
      html: HtmlSanitizerService.sanitize(kop + (o.content || '')),
      atts,
      url: pagina ? pagina.href : null,
    };
  }

  // Note / Question -- ongewijzigd gedrag.
  const atts = (Array.isArray(o.attachment) ? o.attachment : [])
    .map((a) => ({ url: safeUrl(a && a.url), type: (a && a.mediaType) || '' }))
    .filter((m) => m.url);
  if (!atts.some((m) => !m.type || /image/i.test(m.type))) {
    const h = hoes(); if (h) atts.push(h);
  }
  const pagina = pickLink(o.url, () => true);
  return { html: HtmlSanitizerService.sanitize(o.content || ''), atts, url: pagina ? pagina.href : null };
}

/**
 * De site achter een library-uri, of null. Zelfde strengheid als localSlugOf:
 * de uri moet met ONZE basis beginnen en de site moet bestaan -- anders levert
 * andermans /library met dezelfde padstaart hier een volger op onze naam op.
 */
function libraryOwnerSlug(uri) {
  const u = String(uri || '');
  if (!u.endsWith('/library')) return null;
  return localSlugOf(u.slice(0, -'/library'.length));
}

export function buildActor(base, site) {
  const id = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  // FEP-633c §5.3: a ward's follows are gated (guardians approve), so the actor
  // MUST advertise manuallyApprovesFollowers:true — otherwise a follower's server
  // (Mastodon) assumes auto-accept and shows "Following" while we hold it pending.
  const isWard = (() => { try { return Guardianship.listGuardians(site.slug).length > 0; } catch { return false; } })();
  const actor = {
    '@context': AP_CONTEXT,
    id,
    type: 'Person',
    preferredUsername: site.slug,
    name: site.title || site.slug,
    summary: site.tagline || site.description || '',
    // Een Link-ARRAY in plaats van een kale string (shaer-0nh): zo adverteert
    // een kanaal zichzelf, en zo vindt een podcast-app de feed. De text/html
    // staat VOORAAN, want een lezer die maar één url verwacht pakt de eerste --
    // dezelfde vorm die Funkwhale in productie met Mastodon uitwisselt.
    url: channelUrls(base, site),
    ...(channelCategory(site) ? { category: channelCategory(site) } : {}),
    manuallyApprovesFollowers: isWard,
    discoverable: true,
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    followers: `${id}/followers`,
    following: `${id}/following`,
    featured: `${id}/featured`,
    // AS2-kern `streams`: "supplementary Collections which may be of
    // interest" -- precies wat de playlist-lijst is (shaer-ayc, stap 2).
    // Geen eigen vocabulaire nodig, en wie het niet kent negeert het.
    streams: [`${id}/tracks`, `${id}/playlists`],
    // AP §5.6: the private blocked collection (owner-only GET). The server
    // list is the source of truth for Shaer's "in Orbit"; clients keep no
    // separate state.
    blocked: `${id}/blocked`,
    // FEP-1580: de vertaaltabel van een verhuizing plus de Moves die hem
    // rechtvaardigen. Deze twee staan er ALTIJD, ook leeg, en dat is met opzet:
    // de FEP wijst er apart op dat "een verhuizing zonder objecten" en "een
    // server die dit niet kent" anders niet uit elkaar te houden zijn.
    migration: `${id}/migration`,
    moves: `${id}/moves`,
    // FEP-633c §2: shaer:guardians / shaer:isGuardian / shaer:queues
    // (guardianship module owns these).
    ...Guardianship.guardianshipActorProps(id, site.slug),
    // C2S clients (Shaer apps) discover auth + upload here — no hardcoded paths.
    // All four are ActivityPub-spec `endpoints` terms. Dynamic client registration
    // (RFC 7591) is discovered via /.well-known/oauth-authorization-server, not here.
    endpoints: {
      sharedInbox: `${base}/ap/inbox`,
      oauthAuthorizationEndpoint: `${base}/oauth/authorize`,
      oauthTokenEndpoint: `${base}/oauth/token`,
      uploadMedia: `${id}/uploadMedia`,
    },
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem: keys.public_pem,
    },
  };
  if (site.profile_photo) {
    const u = /^https?:/.test(site.profile_photo) ? site.profile_photo : `${base}${site.profile_photo.startsWith('/') ? '' : '/'}${site.profile_photo}`;
    actor.icon = { type: 'Image', url: u };
  }
  // Account creation date — shown by Mastodon + read by indexers (additive, standard AS2).
  if (site.created_at) { try { actor.published = new Date(site.created_at).toISOString(); } catch { /* skip bad date */ } }
  // FEP-7628: former identities this account claims. The OLD server checks for
  // exactly this back-reference before it will move followers here, so the
  // list must be on the public actor, not tucked away in settings.
  try {
    const aka = JSON.parse(site.ap_aliases || '[]');
    if (Array.isArray(aka)) {
      const clean = aka.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u) && u !== id);
      if (clean.length) actor.alsoKnownAs = clean;
    }
  } catch { /* skip malformed ap_aliases */ }
  // FEP-7628 slice 3: this account moved. The old actor stays online AS A
  // SIGNPOST — that is the whole point of keeping it: whoever missed the Move
  // activity (offline server, later visitor) still learns where we went by
  // fetching us. Per the FEP the moved actor "should be considered inactive",
  // and publishers should stop delivering here.
  if (site.moved_to && /^https?:\/\//i.test(String(site.moved_to))) actor.movedTo = String(site.moved_to);
  // Zie movedLock() verderop: het serveren van movedTo is de ENE helft, het
  // stilzetten van de uitgaande kant de andere.
  // De MusicBrainz-koppeling van de artiest (shaer-mbz). Alleen als hij ZELF
  // gekozen heeft -- er staat niets als er niets gekoppeld is, want een lege
  // of geraden verwijzing is erger dan geen.
  //
  // schema:sameAs en niet alsoKnownAs: dat laatste is in AS2 voor vroegere
  // identiteiten van dezelfde actor, en FEP-7628 leunt erop bij een verhuizing.
  // Een MBID hier neerzetten zou een verhuizing kunnen laten mislukken.
  const mbUrl = artiestUrl(site.mb_artist_id);
  if (mbUrl) actor.sameAs = mbUrl;
  // Profile links → PropertyValue rows: Mastodon/PeerTube/WordPress-ActivityPub render these as
  // profile metadata (rel=me enables link-back verification). Additive; ignored by simpler receivers.
  try {
    const links = JSON.parse(site.profile_links || '[]');
    if (Array.isArray(links) && links.length) {
      const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      const rows = links
        .filter((l) => l && l.url && /^https?:/i.test(l.url))
        .map((l) => ({
          type: 'PropertyValue',
          name: esc(l.platform || 'Link'),
          value: `<a href="${esc(l.url).replace(/"/g, '&quot;')}" rel="me nofollow noopener" target="_blank">${esc(String(l.url).replace(/^https?:\/\//, ''))}</a>`,
        }));
      if (rows.length) actor.attachment = rows;
    }
  } catch { /* skip malformed profile_links */ }
  return actor;
}

// Does a post's audio shortcodes reference at least one PLAYABLE (file-backed)
// track? Link-only tracks (external Spotify/YouTube, media_id NULL) don't count —
// they have no Klonkt-hosted audio to embed, so no player card / cover-suppression.
export function hasPlayableAudio(content, siteId) {
  if (!content || !/\[\[(track|album|playlist):/i.test(content)) return false;
  try {
    for (const m of content.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) { const r = db.prepare('SELECT media_id FROM audio_tracks WHERE id = ?').get(m[1]); if (r && r.media_id) return true; }
    for (const m of content.matchAll(/\[\[album:([^\]]+)\]\]/g)) { if (db.prepare('SELECT 1 FROM audio_tracks WHERE site_id = ? AND album = ? AND media_id IS NOT NULL LIMIT 1').get(siteId, m[1].trim())) return true; }
    for (const m of content.matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) { if (db.prepare('SELECT 1 FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? AND t.media_id IS NOT NULL LIMIT 1').get(m[1])) return true; }
  } catch { /* non-fatal */ }
  return false;
}

// A single post as an AS2 Note (the object), and as a Create activity (for outbox/delivery).
export function buildNote(base, site, post, opts = {}) {
  // Replies are Notes too. buildNote is the single entry point for ALL Notes; a reply is
  // (for now) the simple flavor: pre-baked content, no title/cover/image/audio/embed
  // machinery, addressed to the parent actor + thread. This early branch keeps that output
  // byte-identical to the old buildReplyNote. When rich replies land (images/audio/embeds),
  // this branch collapses and replies flow through the full post pipeline below. `post` here
  // is the ap_outbox reply row (id, in_reply_to, content, post_slug, created_at, to_actor).
  if (opts.isReply) {
    const meR = actorId(base, site.slug);
    // Rich replies: attachments column (JSON [{url, mediaType, name}]) → AS2
    // attachment array with absolute URLs and the matching object type.
    let replyAtt;
    try {
      const list = post.attachments ? JSON.parse(post.attachments) : [];
      if (Array.isArray(list) && list.length) {
        replyAtt = list.map((a) => ({
          type: a.mediaType.startsWith('image/') ? 'Image' : a.mediaType.startsWith('audio/') ? 'Audio' : 'Video',
          mediaType: a.mediaType,
          url: /^https?:/i.test(a.url) ? a.url : `${base}${a.url}`,
          name: a.name || undefined,
        }));
      }
    } catch { /* malformed attachments never block the Note */ }
    return {
      id: noteId(base, post.id),
      type: 'Note',
      attributedTo: meR,
      inReplyTo: post.in_reply_to || undefined,
      content: post.content,
      // Reply language (rich replies): the AS2 language map next to `content`.
      contentMap: post.language ? { [post.language]: post.content } : undefined,
      attachment: replyAtt,
      url: post.post_slug ? `${base}/${encodeURIComponent(post.post_slug)}` : undefined,
      published: toISO(post.created_at),
      // A direct note (private mention, shaer-tqc) addresses ONLY its
      // recipients: no Public anywhere, so it cannot be boosted and never
      // shows in public timelines (the Mastodon DM model).
      to: post.visibility === 'direct'
        ? (JSON.parse(post.to_actors || '[]'))
        : (post.to_actor ? [post.to_actor] : [PUBLIC]),
      // Followers-only reply ('friends', shaer detail-view Reply): the parent
      // author (in `to`) + our followers, but NO Public — it does not federate
      // into open discovery. Default reply stays quiet-public (Public in cc).
      cc: post.visibility === 'direct' ? []
        : post.visibility === 'friends' ? [`${meR}/followers`]
          : [PUBLIC, `${meR}/followers`],
      // FEP-633c 5.2.1: a ward's call for help. Only ever on direct notes.
      ...Guardianship.helpRequestProps(post),
      ...Guardianship.waveProps(post),
      ...Guardianship.awayProps(post),
      // FEP-633c §2.2: object hint that the author is a ward.
      ...Guardianship.hasGuardiansProps(site.slug),
      tag: [
        ...mentionTags(post.content),
        ...hashtagTags(base, post.content),
      ],
    };
  }
  const id = noteId(base, post.id);
  const aId = actorId(base, site.slug);
  const human = `${base}/${encodeURIComponent(post.slug)}`;
  // Mastodon ignores a Note's `name`, so put the title INTO the content (bold
  // first line) — the standard blog→fediverse convention. post.content is
  // already sanitized HTML; the title is plain text, so escape it.
  const escTitle = String(post.title || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const titleHtml = post.title ? `<p><strong>${escTitle}</strong></p>` : '';

  // Paid post (klonkt-demo-aki): federate a PUBLIC teaser + link, never the full
  // content, so nothing leaks past the paywall. No media attachments either.
  if (post.paid) {
    const esc = (x) => String(x || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const _firstP = (String(post.content || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [null, ''])[1] || '';
    const rawTeaser = String(post.excerpt || '').trim()
      || _firstP.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
    return {
      '@context': AP_CONTEXT,
      id,
      type: 'Note',
      attributedTo: aId,
      content: `${titleHtml}<p>${esc(rawTeaser)}${rawTeaser ? '…' : ''}</p><p><a href="${human}">Lees de volledige post (supporters)</a></p>`,
      url: human,
      published: toISO(post.published_at || post.created_at || Date.now()),
      to: [PUBLIC],
      cc: [`${aId}/followers`],
      tag: [...hashtagTags(base, post.content)],
      replies: `${id}/replies`,
      ...Guardianship.hasGuardiansProps(site.slug),
    };
  }

  // Images travel as AP `attachment` (Mastodon strips <img> from content). Collect
  // the cover + any inline <img>, make absolute, then strip <img> from the content
  // to avoid duplicate rendering on clients that DO keep them.
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
  const hadAudio = /\[\[(track|album|playlist):/i.test(post.content || '');
  const playable = hasPlayableAudio(post.content || '', site && site.id);
  // A post with an external embed (Spotify/YouTube/SoundCloud/Vimeo/Bandcamp/Apple) should let
  // Mastodon render the embed's player CARD. Mastodon shows EITHER media attachments OR a link
  // card, never both — so when the post has an embed link we skip the image attachments so the
  // card wins. (On Klonkt nothing changes: the cover + the embed player still render.)
  const hasEmbed = (() => {
    const c = post.content || '';
    if (/\[\[embed:/i.test(c)) return true;
    for (const m of c.matchAll(/https?:\/\/[^\s"'<>]+/gi)) if (AudioEmbedService.detectProvider(m[0])) return true;
    return false;
  })();
  // Link-only tracks (external Spotify/YouTube/SoundCloud, no hosted file): collect their links
  // so we federate them — Mastodon cards the first (its player), the rest show as clickable links
  // — instead of a bare "listen on site" link, and we suppress the cover so the card can show.
  const trackEmbedLinks = (() => {
    if (playable) return [];
    const out = [];
    try {
      for (const m of (post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) {
        const r = db.prepare('SELECT media_id, link_spotify, link_youtube, link_soundcloud FROM audio_tracks WHERE id = ?').get(m[1]);
        if (r && !r.media_id) for (const u of [r.link_spotify, r.link_youtube, r.link_soundcloud]) if (u && /^https?:\/\//i.test(u)) out.push(u);
      }
    } catch { /* non-fatal */ }
    return [...new Set(out)].slice(0, 6);
  })();
  const noImages = playable || hasEmbed || trackEmbedLinks.length > 0; // suppress images → let the player/embed card show
  const urls = [];
  // Posts with PLAYABLE hosted audio suppress image attachments so Mastodon renders
  // the player CARD (twitter:player) instead of the cover — media attachment and
  // link/player card are mutually exclusive on Mastodon. Link-only audio (external)
  // keeps its cover (no player card to show).
  // An animated cover federates as the muted loop MP4 (→ a Video attachment): animated WebP is
  // unreliable on Mastodon and its iOS apps; the MP4 plays everywhere. Else the still cover image.
  // Each entry carries the media URL + its alt text (federated as the AS2 attachment `name`, for a11y).
  // Media a C2S composer attached (shaer-j3uh): federate with their REAL
  // mediaType, because the extension map below knows no audio and would call
  // an m4a an Image. Pushed BEFORE the covers: a C2S video doubles as the
  // cover video, and the URL-dedupe keeps the FIRST entry, which must be the
  // one that knows its type and poster. Images also live inline in the
  // content, so the dedupe keeps those single too.
  try {
    for (const a of JSON.parse(post.c2s_attachments || '[]')) {
      if (a && a.url) urls.push({ url: abs(a.url), name: a.name || '', mt: a.mediaType, poster: a.poster ? abs(a.poster) : null });
    }
  } catch { /* malformed never blocks the Note */ }
  if (post.cover_video_url && !noImages) urls.push({ url: abs(post.cover_video_url), name: post.cover_alt || '' });
  else if (post.cover_image_url && !noImages) urls.push({ url: abs(post.cover_image_url), name: post.cover_alt || '' });
  let body = post.content || '';
  // Only federate inline images we can actually serve: absolute http(s) URLs, or our own
  // /media/ uploads. A relative path we don't host (e.g. a stale /images/... ref) would 404
  // and show up as a black tile in Mastodon's attachment grid. Carry the <img alt="…"> through
  // as the attachment description.
  if (!noImages) for (const m of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\bsrc="([^"]+)"/i) || [])[1];
    if (!src || !(/^https?:\/\//i.test(src) || src.startsWith('/media/'))) continue;
    const alt = (tag.match(/\balt="([^"]*)"/i) || [])[1] || '';
    urls.push({ url: abs(src), name: alt });
  }
  body = body.replace(/<img\b[^>]*>/gi, '');
  // Video and audio tags leave the federated content the same way (30-7):
  // they ride as AS2 attachments (c2s_attachments), and the tag itself
  // carries a RELATIVE /media src that is dead everywhere but our own web.
  // Leaving it in showed every remote reader a broken player above the
  // working one. The web keeps its tags: this strip is federation-only.
  body = body.replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, '').replace(/<video\b[^>]*\/?>/gi, '');
  body = body.replace(/<audio\b[^>]*>[\s\S]*?<\/audio>/gi, '').replace(/<audio\b[^>]*\/?>/gi, '');
  // Audio shortcodes: do NOT federate the raw audio file — Klonkt deliberately
  // gates audio (the /audio/stream URL has friction), and shipping it as an AP
  // audio attachment would hand Mastodon a plain, downloadable mp3 URL. Instead,
  // replace the shortcodes with a "🎵 listen on the site" link so the post invites
  // a click-through to the protected player (discovery without leaking the file).
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  // Elke titel met zijn track-id erbij, zodat hij hieronder een EIGEN link
  // krijgt naar #track-<id> op de postpagina (shaer-38y). Zonder id was dit een
  // vetgedrukte opsomming waar je niets mee kon: vijf namen en een enkele
  // "listen on"-link naar de post als geheel. Elke track heeft daar al een
  // anker -- direct ingesloten, in een album of in een playlist -- dus dit
  // wijst naar precies het nummer waar de naam bij hoort.
  const audioLabels = [];
  try {
    const zien = new Set();
    const voegToe = (id, titel) => {
      const t = String(titel || '').trim();
      if (!t) return;
      const sleutel = id || ('naam:' + t);
      if (zien.has(sleutel)) return;
      zien.add(sleutel);
      audioLabels.push({ id: id || null, titel: t });
    };
    // In de volgorde van de POST: een enkele scan over alle drie de vormen,
    // zodat de opsomming leest zoals de post is neergezet.
    for (const m of body.matchAll(/\[\[(track|album|playlist):([^\]]+)\]\]/gi)) {
      const soort = m[1].toLowerCase(), waarde = m[2].trim();
      if (soort === 'track') {
        const r = db.prepare('SELECT id, title FROM audio_tracks WHERE id = ?').get(waarde);
        if (r) voegToe(r.id, r.title);
      } else if (soort === 'album') {
        const rs = db.prepare('SELECT id, title FROM audio_tracks WHERE site_id = ? AND album = ? ORDER BY rowid').all(site.id, waarde);
        if (rs.length) for (const r of rs) voegToe(r.id, r.title);
        else voegToe(null, waarde);            // album zonder tracks: dan maar de naam
      } else {
        for (const r of db.prepare('SELECT t.id, t.title FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position').all(waarde)) voegToe(r.id, r.title);
      }
    }
  } catch { /* non-fatal */ }
  // fedi_open tracks → real AS2 Audio attachments (the actual file URL, served ungated) so
  // EVERY client incl. the Mastodon apps plays them inline natively. Gated tracks (default)
  // stay link/card-only — the file is never exposed for them. Resolve from post.content so a
  // later body mutation can't affect it.
  const openAudio = [];
  if (hadAudio) {
    const seenA = new Set();
    const addRow = (r) => {
      const fn = r.filename || (r.storage_path || '').split('/').pop();
      if (!fn || seenA.has(fn)) return; seenA.add(fn);
      const a = { type: 'Audio', mediaType: r.mime_type || 'audio/mpeg', url: `${base}/audio/stream/${encodeURIComponent(fn)}`, name: r.title || 'Audio' };
      // Cover art on the Audio attachment (AS2 `icon`): track cover, else the post cover.
      // Mastodon renders it as the artwork thumbnail on its native audio player.
      const art = abs(r.cover_url || post.cover_image_url || null);
      if (art) a.icon = { type: 'Image', mediaType: guessMediaType(art), url: art };
      openAudio.push(a);
    };
    const SEL = 'SELECT t.title, t.cover_url, m.filename, m.storage_path, m.mime_type FROM audio_tracks t JOIN media m ON m.id = t.media_id WHERE t.fedi_open = 1 AND ';
    try {
      for (const mm of (post.content || '').matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) { const r = db.prepare(SEL + 't.id = ?').get(mm[1]); if (r) addRow(r); }
      for (const mm of (post.content || '').matchAll(/\[\[album:([^\]]+)\]\]/g)) for (const r of db.prepare(SEL + 't.site_id = ? AND t.album = ? ORDER BY t.rowid').all(site.id, mm[1].trim())) addRow(r);
      for (const mm of (post.content || '').matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) for (const r of db.prepare('SELECT t.title, t.cover_url, m.filename, m.storage_path, m.mime_type FROM playlist_tracks pt JOIN audio_tracks t ON t.id = pt.track_id JOIN media m ON m.id = t.media_id WHERE t.fedi_open = 1 AND pt.playlist_id = ? ORDER BY pt.position').all(mm[1])) addRow(r);
    } catch { /* non-fatal */ }
  }
  // ONVERTAALD voor een verhuizing (FEP-1580). De doelinstantie IS een Klonkt:
  // die rendert [[track:]], [[album:]] en [[playlist:]] zelf en maakt er een
  // speler van. Bakken we ze eerst om, dan komt er een tekstlink aan en is de
  // speler weg. Onherstelbaar bovendien: het bakken STRIPT de shorthand en
  // plakt achteraan hooguit VIER titels, dus een album van tien nummers
  // overleeft het niet.
  //
  // Dezelfde regel als bij de outbox en de tracks: wie ondertekend vraagt
  // namens de actor waar wij naartoe verhuisd zijn, krijgt onze eigen kijk.
  if (!opts.rauweInhoud) body = body.replace(/\[\[(track|album|playlist):[^\]]+\]\]/gi, '');
  // External embeds ([[embed:url]]) → emit the bare URL as a link so Mastodon
  // renders its OWN preview/player card (YouTube/Spotify/SoundCloud/etc) instead
  // of federating the raw shortcode text.
  body = body.replace(/\[\[embed:([^\]]+)\]\]/gi, (mm, raw) => {
    const u = esc(raw.trim().replace(/&amp;/g, '&'));
    return `<p><a href="${u}">${u}</a></p>`;
  });
  if (hadAudio && !opts.rauweInhoud) {
    // Elke titel als eigen link naar zijn anker; een titel zonder id (een
    // albumnaam zonder tracks) blijft gewone tekst.
    const lbl = audioLabels.slice(0, 4)
      .map((a) => (a.id ? `<a href="${human}#track-${esc(a.id)}">${esc(a.titel)}</a>` : esc(a.titel)))
      .join(', ');
    if (trackEmbedLinks.length) {
      // Link-only track(s): emit the external link(s). Mastodon cards the first (Spotify → its
      // player), the rest render as clickable links — the fediverse-native "embed + links".
      body += `<p>🎵 ${lbl ? `<strong>${lbl}</strong>` : ''}</p>`;
      for (const u of trackEmbedLinks) { const eu = esc(u); body += `<p><a href="${eu}">${eu}</a></p>`; }
    } else {
      // For playable posts, append a version param to the listen-link so Mastodon
      // sees a NEW card URL and re-crawls it (fresh SQUARE player card) instead of
      // reusing the cached landscape one. Invisible: the link TEXT stays clean, the
      // page ignores the param. Bump FEDI_CARD_VER when the card dimensions change.
      const listenHref = playable ? `${human}?fc=${FEDI_CARD_VER}` : human;
      body += `<p>🎵 ${lbl ? `<strong>${lbl}</strong> — ` : ''}<a href="${listenHref}">listen on ${esc(site.title || 'the site')}</a></p>`;
    }
  }
  // Klonkt renders post content with white-space:pre-wrap, so raw newlines ARE line
  // breaks on the site. Mastodon (plain HTML) collapses whitespace and would drop them,
  // so convert newlines to <br> for the federated copy (content already made with
  // shift+enter uses <br> and has no \n → this is a no-op there).
  body = body.replace(/\r?\n/g, '<br>');
  body = linkHashtags(base, body); // link inline #hashtags in the post body too
  body = linkUrls(body);           // bare URLs → clickable links on the federated copy
  // Append the tags-field hashtags to the content so Mastodon renders them as clickable
  // hashtags (a Hashtag that's only in the `tag` array isn't shown inline). CamelCase
  // multi-word tags; skip any already present inline in the body.
  {
    const inlineTags = new Set(hashtagTags(base, body).map((h) => h.name.slice(1).toLowerCase()));
    const addSeen = new Set();
    const tagLinks = normalizeTags(post.tags).map(tagParts).filter(Boolean)
      .filter((p) => !inlineTags.has(p.slug) && !addSeen.has(p.slug) && addSeen.add(p.slug))
      .map((p) => `<a href="${base}/tag/${encodeURIComponent(p.slug)}" class="mention hashtag" rel="tag">#${p.label}</a>`);
    if (tagLinks.length) body += `<p>${tagLinks.join(' ')}</p>`;
  }
  const seen = new Set();
  const attachment = urls.filter((x) => x && x.url)
    .filter((x) => { if (seen.has(x.url)) return false; seen.add(x.url); return true; })
    .map((x) => { const mt = x.mt || guessMediaType(x.url); // the stored type wins; the extension map is the fallback
      const ty = /^image\//i.test(mt) ? 'Image' : /^video\//i.test(mt) ? 'Video' : /^audio\//i.test(mt) ? 'Audio' : 'Document';
      const a = { type: ty, mediaType: mt, url: x.url };
      if (x.name) a.name = String(x.name).slice(0, 1500); // alt text / description (AS2 `name`)
      if (x.poster) a.icon = { type: 'Image', url: x.poster }; // the video's still (shaer-zowq)
      return a; });
  for (const a of openAudio) attachment.push(a); // fedi_open tracks → native Audio players

  // Inline @user@host mentions: the Mention tag objects + the mentioned actor URIs. Only
  // present when the content was already mention-linked (deliverCreate/Update resolve them
  // at send time); a plain buildNote (outbox/notes) yields none.
  const _mentionTags = mentionTags(body);
  const _mentionCc = _mentionTags.map((t) => t.href);

  const note = {
    id,
    type: 'Note',
    attributedTo: aId,
    content: titleHtml + body,
    url: human,
    published: new Date(post.published_at || post.created_at || Date.now()).toISOString(),
    // fan_only = "fans only" → followers-only visibility (delivered to your followers
    // but not addressed to Public, so Mastodon shows it only to them and can't boost it).
    to: (post.fan_only || post.ap_visibility === 'quiet') ? [`${aId}/followers`] : [PUBLIC],
    // Mentioned actors (from inline @user@host links the caller resolved) are addressed in cc
    // so Mastodon notifies them; empty unless the content was mention-linked (delivery time).
    cc: [...new Set([
      ...(post.ap_visibility === 'quiet' ? [PUBLIC] : []),          // quiet public: Public in cc, not to
      ...((post.fan_only || post.ap_visibility === 'quiet') ? [] : [`${aId}/followers`]),
      ..._mentionCc])],
    tag: [...buildHashtagList(base, post.tags, body), ..._mentionTags, ...playlistLinkTags(base, site, post.content, post)],
    replies: `${id}/replies`,
    // NSFW → Mastodon-style content warning: sensitive (blurs media) + a summary/spoiler
    // (hides the whole post behind a "Gevoelige inhoud" button until the reader opens it).
    sensitive: !!post.nsfw,
  };
  // FEP-633c §2.2: object hint that the author is a ward (safely ignorable).
  Object.assign(note, Guardianship.hasGuardiansProps(site.slug));
  // FEP-044f: this post quotes a fediverse object. Emit it the way the network
  // actually reads it, and address the quoted author so they get told.
  applyQuoteProps(note, post.quote_uri, post.quote_actor);
  if (post.nsfw) note.summary = post.content_warning || 'Gevoelige inhoud';
  if (attachment.length) note.attachment = attachment;
  // When the cover attachment is suppressed (hosted audio OR an external embed/link-only track →
  // so Mastodon shows the player/link card, not media), still expose the cover via AS2 `image` so
  // card/grid consumers (the Klonkt Cirkel/News feed) can show it. Mastodon ignores a Note's
  // `image`, so its card is unaffected — but a Klonkt receiver reads it (handleInbox o.image).
  if (post.cover_image_url && noImages) {
    const cov = abs(post.cover_image_url);
    if (cov) { note.image = { type: 'Image', mediaType: guessMediaType(cov), url: cov }; if (post.cover_alt) note.image.name = String(post.cover_alt).slice(0, 1500); }
  }
  // Experiment (mirrors PeerTube / schema.org `embedUrl`): point at the GATED player page
  // (/embed) so a client that honours embedUrl can show an inline player WITHOUT ever
  // getting the audio file — the anti-steal posture is untouched. `embedUrl` is a real
  // standard field name (not a Klonkt invention); if Mastodon's apps honour it on a Note we
  // make it JSON-LD-clean with a context term, otherwise it degrades to the player card.
  if (playable) note.embedUrl = `${base}/embed?post=${encodeURIComponent(post.slug)}`;
  // Content language → AS2 contentMap (a BCP-47-keyed copy of the content). Mastodon reads the
  // language from its key for the timeline language filter + the translate button. Emitted
  // alongside `content` (Mastodon sends both); a plain receiver just uses `content`.
  if (post.language && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(post.language)) note.contentMap = { [post.language]: note.content };
  // A hosted poll → federate as an AS2 Question (options + live tally). Do this last so it
  // reuses the note's content/addressing/tags, then swaps the type and strips media.
  const ownPoll = parseOwnPoll(post.poll_json);
  if (ownPoll) applyPollToNote(note, post.id, ownPoll);
  return note;
}

// All reply note URIs on a local post (inbound fediverse replies + our own
// outbound replies) — backs the Note's `replies` Collection so remote servers
// can fetch the whole thread.
export function getReplyUris(base, postId) {
  const out = [];
  try {
    for (const r of db.prepare("SELECT object_uri FROM ap_interactions WHERE kind = 'reply' AND post_id = ? AND object_uri != '' ORDER BY created_at").all(postId)) out.push(r.object_uri);
    for (const r of db.prepare('SELECT id FROM ap_outbox WHERE post_id = ? ORDER BY rowid').all(postId)) out.push(`${base}/ap/notes/${r.id}`);
  } catch { /* non-fatal */ }
  return out;
}

// Notifications "seen" tracking → a real bell badge. Stored per site in app_settings.
export function markNotificationsSeen(slug) {
  try {
    db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP")
      .run(`fedi_notif_seen:${slug}`, new Date().toISOString());
  } catch { /* non-fatal */ }
}
export function countUnseenNotifications(slug) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`fedi_notif_seen:${slug}`);
    const seen = row ? Date.parse(row.value) : 0;
    let n = 0;
    for (const it of getNotifications(slug, 50)) { if (Date.parse(it.created_at) > seen) n++; }
    return n;
  } catch { return 0; }
}
// The seen-watermark itself (ms epoch, 0 = never marked) — the Messages page reads it
// BEFORE marking seen, so it can render unread dots on the items newer than last visit.
export function notificationsSeenAt(slug) {
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(`fedi_notif_seen:${slug}`);
    return row ? (Date.parse(row.value) || 0) : 0;
  } catch { return 0; }
}

// Messages = the unified inbox (Reacties + Meldingen merged, decision Robin+Bart 2026-07-16):
// every notification PLUS your own outbound replies ('sent', with edit/delete via their
// outboxId), sorted as one stream. Consecutive likes/boosts on the same post collapse into
// one grouped item (actors list + count) so activity doesn't drown out conversations.
/** ap_outbox.attachments ([{url, mediaType, name}]) naar de vorm die note-body
 *  leest (media_json: [{url, type, name}]). Geeft null bij niets of rommel,
 *  zodat een kapotte kolom hooguit media kost en niet de hele regel. */
function outboxMediaJson(attachments) {
  if (!attachments) return null;
  try {
    const list = JSON.parse(attachments);
    if (!Array.isArray(list) || !list.length) return null;
    const media = list
      .filter((a) => a && a.url)
      .map((a) => ({ url: a.url, type: a.mediaType || a.type || '', name: a.name || undefined }));
    return media.length ? JSON.stringify(media) : null;
  } catch { return null; }
}

export function getMessages(slug, limit, offset) {
  const off = Math.max(0, offset || 0);
  const lim = limit || 60;
  // The stream is grouped (consecutive likes/boosts collapse), so paging is done by
  // recomputing the whole stream top-down and slicing [off, off+lim] — stable across
  // pages. Fetch a buffer past off+lim so grouping-shrinkage can't hide a full page.
  const need = off + lim + 100;
  const items = getNotifications(slug, need);
  try {
    for (const m of listOutbox(slug).slice(0, need)) {
      items.push({
        type: 'sent', outboxId: m.id, to_handle: m.to_handle, to_actor: m.to_actor, to_actors: m.to_actors,
        in_reply_to: m.in_reply_to, post_slug: m.post_slug, content: m.content,
        editable: m.editable, language: m.language, created_at: m.created_at,
        // Je eigen bericht hoort er hetzelfde uit te zien als dat van een ander:
        // note-body rendert Berichten, de Krant en de Guardian-PWA, maar leest
        // media uit media_json met een `type`, terwijl ap_outbox ze als
        // `attachments` met een `mediaType` bewaart. Zonder deze vertaling kwam
        // een foto die JIJ meestuurde als kale tekst binnen.
        media_json: outboxMediaJson(m.attachments),
      });
    }
  } catch { /* ignore */ }
  // Een verzonden antwoord kent zijn post_slug maar niet de titel (ap_outbox
  // bewaart die niet). Zonder titel toont een draad waarin JIJ als enige iets
  // zei alleen een slug, dus vullen we ze in één query aan.
  try {
    const missing = [...new Set(items.filter((i) => i.post_slug && !i.post_title).map((i) => i.post_slug))];
    if (missing.length) {
      const rows = db.prepare(
        `SELECT slug, title FROM posts WHERE slug IN (${missing.map(() => '?').join(',')})
           AND site_id = (SELECT id FROM sites WHERE slug = ?)`,
      ).all(...missing, slug);
      const byslug = new Map(rows.map((r) => [r.slug, r.title]));
      for (const i of items) if (i.post_slug && !i.post_title) i.post_title = byslug.get(i.post_slug) || null;
    }
  } catch { /* zonder titel valt de draad terug op de slug */ }
  items.sort((a, b) => _msgTs(b) - _msgTs(a)); // NaN-safe (zie getNotifications)
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if ((it.type === 'like' || it.type === 'announce') && prev && prev.type === it.type
        && prev.post_slug === it.post_slug) {
      prev.actors = prev.actors || [prev.name || prev.handle || '?'];
      prev.actors.push(it.name || it.handle || '?');
      prev.count = (prev.count || 1) + 1;
      continue;
    }
    out.push(it);
  }
  // Antwoorden, mentions en je eigen verzonden berichten vouwen samen tot
  // draden; likes/boosts/follows/reports blijven losse regels. Na deze stap
  // telt een draad als één item voor de paginering, wat klopt: je scrolt door
  // gesprekken, niet door losse zinnen.
  return groupConversations(out).slice(off, off + lim);
}

// De drie soorten die samen een gesprek vormen. Vroeger zaten ze in drie
// aparte chips: 'reply' en 'mention' onder Berichten/Gesprekken (afhankelijk van
// de zichtbaarheid) en 'sent' onder Verzonden. Wie een uitwisseling wilde volgen
// moest dus tussen chips heen en weer, terwijl het één draad is.
const CONV_TYPES = new Set(['reply', 'mention', 'sent']);

/** Waar hangt dit bericht aan? Twee soorten draden, en de volgorde telt:
 *
 *  1. Aan een post van jou. Een ontvangen antwoord kent zijn post via de join
 *     op `posts`, een verzonden antwoord via ap_outbox.post_slug. Dat is
 *     dezelfde sleutel, en daarom staan ze nu in dezelfde draad.
 *  2. Aan een persoon. Een mention hangt aan niets van jou (het is iemands
 *     eigen post waarin je genoemd wordt) en heeft geen post_slug; die draad
 *     loopt per tegenpartij.
 *
 *  De post wint van de persoon: twee mensen die onder dezelfde post reageren
 *  voeren één gesprek, geen twee. Geeft null terug voor alles wat geen gesprek
 *  is (likes, boosts, follows, reports, poll-uitslagen); die stromen ongemoeid
 *  door.
 */
export function threadKey(it) {
  if (!it || !CONV_TYPES.has(it.type)) return null;
  if (it.post_slug) return `post:${it.post_slug}`;
  let who = it.handle || it.to_handle || '';
  // Een direct bericht kan zonder to_handle in de tabel staan (de handle van de
  // ontvanger was niet af te leiden). De eerste uit to_actors is dan alsnog de
  // tegenpartij, en zonder deze terugval kreeg een gesprek dat JIJ begon geen
  // draad -- precies het geval waarin het meest onlogisch is dat het los blijft.
  if (!who && it.to_actors) {
    try {
      const first = JSON.parse(it.to_actors)[0];
      if (first) who = deriveHandle(first);
    } catch { /* geen bruikbare lijst → geen sleutel, het blijft een losse regel */ }
  }
  const norm = String(who || '').trim().toLowerCase().replace(/^@/, '');
  return norm ? `actor:${norm}` : null;
}

/** Vouw losse berichten samen tot draden, met alles wat geen gesprek is
 *  ongemoeid ertussen. Verwacht [items] al gesorteerd op created_at aflopend
 *  (zoals getMessages ze aanlevert); de draad komt daardoor op de plek van zijn
 *  nieuwste bericht te staan en `created_at` van de draad IS dat bericht. Binnen
 *  de draad draait het om: een gesprek leest naar beneden, oud naar nieuw.
 */
export function groupConversations(items) {
  const threads = new Map();
  const out = [];
  for (const it of items || []) {
    const key = threadKey(it);
    if (!key) { out.push(it); continue; }
    let t = threads.get(key);
    if (!t) {
      // Eerste keer dat we deze draad zien = het nieuwste bericht erin, want de
      // invoer is aflopend gesorteerd. Vandaar created_at hier en niet later.
      t = { type: 'thread', key, post: null, people: [], messages: [], created_at: it.created_at };
      threads.set(key, t);
      out.push(t);
    }
    t.messages.push(it);
    // De context bij de draad: gaat het over een post, dan hoort de link
    // erbij, anders is een los antwoord in een lijst niet te plaatsen.
    // De titel blijft LEEG zolang hij onbekend is, in plaats van terug te
    // vallen op de slug: het nieuwste bericht in een draad is vaak je eigen
    // verzonden antwoord, en dat kent alleen de slug. Zou die de titel worden,
    // dan kan het ontvangen antwoord eronder de echte titel niet meer
    // invullen. De terugval op de slug hoort in de weergave, niet in de data.
    if (it.post_slug) {
      if (!t.post) t.post = { slug: it.post_slug, title: it.post_title || null };
      else if (!t.post.title && it.post_title) t.post.title = it.post_title;
    }
  }
  for (const t of threads.values()) {
    t.messages.sort((a, b) => _msgTs(a) - _msgTs(b));
    t.count = t.messages.length;
    // Wie zit er in dit gesprek, jij niet meegerekend: 'sent' ben jij.
    const seen = new Set();
    for (const m of t.messages) {
      if (m.type === 'sent') continue;
      const h = m.handle || m.name;
      if (!h || seen.has(h)) continue;
      seen.add(h);
      t.people.push({ name: m.name, handle: m.handle, icon: m.icon, url: m.url });
    }
    // Heb JIJ in deze draad iets gezegd? Bepaalt of hij als uitwisseling of als
    // onbeantwoord bericht leest.
    t.mine = t.messages.some((m) => m.type === 'sent');
    // Waar gaat een antwoord uit deze draad heen? Twee paden, en ze sluiten
    // elkaar uit: hangt de draad aan een post, dan antwoord je op het NIEUWSTE
    // ontvangen bericht erin (dat is de parent van de thread) -- anders is het
    // een direct bericht aan de tegenpartij.
    const inkomend = t.messages.filter((m) => m.type !== 'sent');
    const laatste = inkomend[inkomend.length - 1];
    t.replyTo = {
      interactionId: (laatste && laatste.interactionId) || null,
      postSlug: (t.post && t.post.slug) || null,
      actorUri: (laatste && (laatste.actorUri || laatste.url))
        || (t.messages.find((m) => m.to_actor) || {}).to_actor
        || (() => { try { return JSON.parse((t.messages.find((m) => m.to_actors) || {}).to_actors || '[]')[0] || null; } catch { return null; } })(),
    };
  }
  return out;
}

export function buildCreate(base, site, post, opts = {}) {
  const note = buildNote(base, site, post, opts);
  return {
    '@context': AP_CONTEXT,
    id: note.id + '#create',
    type: 'Create',
    actor: actorId(base, site.slug),
    published: note.published,
    to: note.to,
    cc: note.cc,
    object: note,
  };
}


/**
 * De outbox: wat deze actor heeft uitgebracht. Posts EN tracks (shaer-0nh,
 * stap 4).
 *
 * WAAROM HIER EN NIET IN EEN BEZORGING. Een kanaal-lezer HAALT de outbox op --
 * zo heb ik zelf Funkwhales kanaal uitgelezen. Een Create(Audio) ook naar de
 * inboxen van volgers duwen zou schade doen: Mastodon neemt Audio aan als
 * statustype, dus bij een album-post zou dezelfde muziek twee keer in hun
 * tijdlijn komen -- een keer als bijlage bij de Note, en dan nog N keer los.
 * De post is het bericht, de outbox is de discografie.
 *
 * Door elkaar op datum, nieuwste eerst, zodat de outbox één verhaal vertelt in
 * plaats van twee lijstjes achter elkaar.
 *
 * De tracks komen als ARGUMENT binnen, net als de posts, en worden hier
 * uitdrukkelijk NIET zelf opgehaald. De route beslist wie wat mag zien -- een
 * geblokkeerde bezoeker krijgt daar een lege outbox, en een bouwer die stiekem
 * zijn eigen database bevraagt zou dwars door die deur heen leveren.
 */
/**
 * Een PAGINA van de outbox, in SQL (shaer-sk4).
 *
 * De outbox mengt twee bronnen: posts en open tracks, gevlochten op datum. Een
 * offset over die twee kan niet met twee losse queries -- je weet niet hoeveel
 * van elk er in pagina drie horen. Vandaar een UNION met de datum als sleutel,
 * daar de LIMIT/OFFSET overheen, en pas dan de rijen zelf ophalen.
 *
 * Wat er stond was geen paginering maar een KAP: de route haalde twintig posts
 * en hield daarvan twintig items over. Alles daarvoor was niet op een volgende
 * pagina maar helemaal onbereikbaar.
 *
 * @param {boolean} fanOnly  mag de lezer ook de fans-only posts zien?
 */
export function outboxSlice(siteId, { fanOnly = false, offset = 0, limit = MAX_OUTBOX } = {}) {
  const fanClause = fanOnly ? '' : 'AND (p.fan_only IS NULL OR p.fan_only = 0)';
  const unie = `
    SELECT 'post' AS soort, p.id AS id, COALESCE(p.published_at, p.created_at) AS wanneer
      FROM posts p WHERE p.site_id = ? AND p.status = 'published' ${fanClause}
    UNION ALL
    SELECT 'track', t.id, t.created_at
      FROM audio_tracks t WHERE t.site_id = ? AND t.fedi_open = 1`;
  let rijen = [], totaal = 0;
  try {
    totaal = db.prepare(`SELECT COUNT(*) n FROM (${unie})`).get(siteId, siteId).n;
    rijen = db.prepare(`SELECT soort, id FROM (${unie}) ORDER BY wanneer DESC LIMIT ? OFFSET ?`)
      .all(siteId, siteId, limit, Math.max(0, offset));
  } catch { return { posts: [], tracks: [], totaal: 0 }; }

  const postIds = rijen.filter((r) => r.soort === 'post').map((r) => r.id);
  const trackIds = rijen.filter((r) => r.soort === 'track').map((r) => r.id);
  const gaten = (n) => Array.from({ length: n }, () => '?').join(',');
  const posts = postIds.length ? db.prepare(
    // fan_only en ap_visibility MOETEN mee. buildNote adresseert hierop, en
    // zonder deze twee kolommen is post.fan_only altijd undefined: elke
    // fan-only post ging dan de outbox uit met to: as:Public, terwijl hij
    // alleen aan vrienden geserveerd wordt. Een volger kreeg dus een
    // vrienden-post met een publiek etiket erop, en die mag hij dan publiek
    // boosten. Gevonden tijdens de FEP-1580 end-to-end test (shaer-fuyo).
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning,
            c2s_attachments, quote_json, embed_json, published_at, created_at,
            fan_only, ap_visibility
       FROM posts WHERE id IN (${gaten(postIds.length)})`).all(...postIds) : [];
  const tracks = trackIds.length ? db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
       FROM audio_tracks t JOIN media m ON m.id = t.media_id
      WHERE t.id IN (${gaten(trackIds.length)})`).all(...trackIds) : [];
  return { posts, tracks, totaal };
}

export function buildOutbox(base, site, posts, tracks = [], { page = false, totalItems, alGesneden = false, rauweInhoud = false } = {}) {
  const id = `${actorId(base, site.slug)}/outbox`;
  const wanneer = (x) => Date.parse(x && x.published ? x.published : 0) || 0;
  const items = [
    ...(posts || []).map((p) => buildCreate(base, site, p, { rauweInhoud })),
    // Eén zoekopdracht voor alle tracks samen, niet per stuk.
    ...(() => {
      const posts = (tracks || []).length && site.id ? trackHostPosts(site.id) : null;
      return (tracks || []).map((r) => buildTrackCreate(base, site, r, { hostPosts: posts }));
    })(),
  ]
    .sort((a, b) => wanneer(b) - wanneer(a))
    .slice(0, alGesneden ? Infinity : MAX_OUTBOX);
  // WAT HIER NOG NIET GEPAGINEERD IS, en dat hoort genoemd (shaer-sk4): deze
  // lijst is al door de route op twintig rijen afgekapt, dus pagina 2 is leeg.
  // Echt doorbladeren vraagt een LIMIT/OFFSET in SQL -- en dat is hier lastiger
  // dan bij volgers, want posts en tracks worden op DATUM door elkaar gevlochten
  // en komen uit twee tabellen. Dat vraagt een UNION met een offset erover, geen
  // tweede slice. De vorm klopt nu wel: pagina 2 zegt eerlijk dat hij leeg is en
  // biedt geen `next` aan, in plaats van pagina 1 nog eens te geven.
  // GEPAGINEERD, ook al past alles op een pagina (Funkwhale, 11-8).
  //
  // Hun serializer weigerde onze outbox met "first: This field is required" en
  // "last: This field is required". AS2 EIST ze niet -- een collectie mag zijn
  // items inline dragen -- maar bijna iedereen pagineert, en een lezer die de
  // paginaweg volgt liep hier dood. Dit is de eerste concrete reden die we
  // hoorden waarom er niets van ons binnenkwam.
  //
  // De items blijven WEL inline op de wortel. Shaer bouwt zijn feed daaruit, en
  // wie hem vandaag leest hoort er morgen niet voor te hoeven pagineren. Er is
  // precies een pagina, dus first en last wijzen naar dezelfde.
  return pagedCollection(id, items, { page, totalItems, alGesneden });
}

// Public callers get a count-only collection (privacy). The authenticated
// account owner (a C2S bearer scoped to this site) gets the real actor URIs via
// `items`, so their own client can build a friends list.
export function buildFollowers(base, site, count, items = null, { page = false } = {}) {
  const id = `${actorId(base, site.slug)}/followers`;
  // count-only for the public; full for the owner
  return pagedCollection(id, items || [], { totalItems: items ? items.length : (count || 0), page });
}

// The accounts this site follows — count only, mirroring buildFollowers. The spec lists
// `following` as a standard actor property; Hubzilla/Friendica + crawlers expect it.
export function buildFollowing(base, site, count, items = null, { page = false } = {}) {
  const id = `${actorId(base, site.slug)}/following`;
  // count-only for the public; full for the owner
  return pagedCollection(id, items || [], { totalItems: items ? items.length : (count || 0), page });
}

// Pinned posts → the actor's `featured` collection. Mastodon reads this and shows
// these as the "Featured" tab (pinned to the profile). Posts come ordered by pin
// rank; embedded as full Notes so a remote server doesn't need extra fetches.
export function buildFeatured(base, site, posts) {
  const id = `${actorId(base, site.slug)}/featured`;
  const items = (posts || []).map((p) => buildNote(base, site, p));
  return pagedCollection(id, items);
}

// ── Playlist als AP-collectie (shaer-ayc, stap 1 van het Funkwhale-spoor) ──
// Een playlist heeft, anders dan een album-als-tekstveld, een id — dus kan hij
// een stabiele URI dragen en federeren. De vorm is bewust kaal AS2: een
// OrderedCollection van Audio-objecten, dezelfde rijvorm die een post als
// attachment meestuurt, zodat elke client die post-audio al speelt dit ook
// speelt.
//
// De poortregel verandert hier NIET: alleen fedi_open-tracks staan erin, met
// echte bestands-URL. Een gated track is niet "een rij zonder url" maar
// afwezig — wie de collectie leest ziet het open deel en kan niet aftellen
// hoeveel er achter de poort staat. totalItems telt daarom ook alleen het
// open deel: een eerlijke telling over wat er werkelijk in de collectie staat,
// niet over wat wij thuis in de kast hebben.

// ── followers store (lazy stmts) ──────────────────────────────────
let _insF, _updFDisp, _delF, _listF, _cntF;
function fStmts() {
  if (!_insF) {
    _insF = db.prepare('INSERT OR IGNORE INTO ap_followers (slug, actor_uri, inbox, shared_inbox, name, handle, icon, created_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _updFDisp = db.prepare('UPDATE ap_followers SET name = COALESCE(?, name), handle = COALESCE(?, handle), icon = COALESCE(?, icon) WHERE slug = ? AND actor_uri = ?');
    _delF = db.prepare('DELETE FROM ap_followers WHERE slug = ? AND actor_uri = ?');
    _listF = db.prepare('SELECT inbox, shared_inbox FROM ap_followers WHERE slug = ?');
    _cntF = db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ?');
  }
  return { ins: _insF, del: _delF, list: _listF, cnt: _cntF };
}
export function followerCount(slug) { return fStmts().cnt.get(slug).n; }

// Followers with delivery health, for the management list. Never-delivered accounts
// first, then oldest successful delivery first — i.e. the cleanup candidates on top.
export function listFollowers(slug) {
  return db.prepare(
    `SELECT id, actor_uri, inbox, shared_inbox, created_at, last_delivery_at, last_error_at
     FROM ap_followers WHERE slug = ?
     ORDER BY (last_delivery_at IS NULL) DESC, last_delivery_at ASC, created_at ASC`
  ).all(slug);
}
// Manually drop a follower after a check (a still-live account would have to re-follow).
export function removeFollower(slug, id) {
  const info = db.prepare('DELETE FROM ap_followers WHERE slug = ? AND id = ?').run(slug, id);
  return info.changes > 0;
}

// Best cached display for an actor URI, across the caches Klonkt already fills:
// followers (now with name/icon), following, interactions, timeline, mentions.
// Falls back to a handle derived from the URI. Display info is not sensitive.
export function actorDisplay(slug, uri) {
  const ok = (r) => r && (r.name || r.icon);
  try {
    let r = db.prepare('SELECT name, handle, icon FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(slug, uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT name, handle, icon FROM ap_following WHERE slug = ? AND actor_uri = ?').get(slug, uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT actor_name AS name, actor_handle AS handle, actor_icon AS icon FROM ap_interactions WHERE actor_uri = ? AND (actor_name IS NOT NULL OR actor_icon IS NOT NULL) ORDER BY created_at DESC LIMIT 1').get(uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT author_name AS name, author_handle AS handle, author_icon AS icon FROM ap_timeline WHERE author_uri = ? AND (author_name IS NOT NULL OR author_icon IS NOT NULL) LIMIT 1').get(uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
    r = db.prepare('SELECT actor_name AS name, actor_handle AS handle, actor_icon AS icon FROM ap_mentions WHERE actor_uri = ? AND (actor_name IS NOT NULL OR actor_icon IS NOT NULL) ORDER BY created_at DESC LIMIT 1').get(uri);
    if (ok(r)) return { name: r.name, handle: r.handle || deriveHandle(uri), icon: r.icon };
  } catch { /* ignore */ }
  return { name: null, handle: deriveHandle(uri), icon: null };
}

// FEP-9876: does this `Prefer` header ask for enriched (embedded) members?
// Pure and testable; the route sets the response headers around it.
export function prefersEnriched(preferHeader) {
  return /(^|[,;\s])return=representation($|[,;\s])/i.test(String(preferHeader || ''));
}

// AS2 actor reference with display, for the owner C2S followers/following view.
// preferredUsername = the local part of the handle; name = the set display name.
export function buildActorRef(slug, uri) {
  const d = actorDisplay(slug, uri);
  const user = d.handle && d.handle[0] === '@' ? d.handle.slice(1).split('@')[0] : null;
  const out = { id: uri, type: 'Person' };
  if (d.name) out.name = d.name;
  if (user) out.preferredUsername = user;
  if (d.icon) out.icon = { type: 'Image', url: d.icon };
  return out;
}

// The site's OWN display info in the same shape as `shaer:author` on timeline
// entries. The owner's app reads its own posts from the outbox, which carried
// no author info, so every card but your own had a byline (Robins melding,
// 30-7: geen header van self op eigen posts).
export function selfAuthor(base, site) {
  const out = {
    name: site.title || site.slug,
    handle: `@${site.slug}@${String(base).replace(/^https?:\/\//, '')}`,
    url: `${base}/${site.slug === site.primary_slug ? '' : 'user/' + encodeURIComponent(site.slug)}`,
  };
  if (site.profile_photo) {
    out.icon = /^https?:/.test(site.profile_photo) ? site.profile_photo : `${base}${site.profile_photo.startsWith('/') ? '' : '/'}${site.profile_photo}`;
  }
  return out;
}

// Merge who-you-follow (ap_following, rich display) with who-follows-you (ap_followers,
// delivery health) into ONE connections list, keyed by actor_uri. Each entry gets a
// direction (following →, follower ←, mutual ↔) and, for accounts we deliver to, an
// `unreachable` flag (never delivered, or last attempt failed after the last success) so
// the view can split dead connections into their own section. Powers the Connect page.
export function listConnections(slug) {
  const byUri = new Map();
  for (const f of listFollowing(slug)) {
    byUri.set(f.actor_uri, {
      actor_uri: f.actor_uri, name: f.name || null, handle: f.handle || null,
      icon: f.icon || null, url: f.url || null, auto_boost: f.auto_boost ? 1 : 0,
      status: f.status || null, following: true, follower: false,
      last_delivery_at: null, last_error_at: null, follower_id: null,
    });
  }
  for (const fo of listFollowers(slug)) {
    const e = byUri.get(fo.actor_uri);
    if (e) { e.follower = true; e.last_delivery_at = fo.last_delivery_at; e.last_error_at = fo.last_error_at; e.follower_id = fo.id; }
    else byUri.set(fo.actor_uri, {
      actor_uri: fo.actor_uri, name: null, handle: null, icon: null, url: null,
      auto_boost: 0, status: null, following: false, follower: true,
      last_delivery_at: fo.last_delivery_at, last_error_at: fo.last_error_at, follower_id: fo.id,
    });
  }
  return [...byUri.values()].map((e) => {
    e.direction = (e.following && e.follower) ? 'mutual' : (e.following ? 'following' : 'follower');
    e.unreachable = e.follower && (!e.last_delivery_at || (!!e.last_error_at && (!e.last_delivery_at || e.last_error_at > e.last_delivery_at)));
    return e;
  });
}

// ── inbound interactions store (replies / likes / boosts) + our outbound replies ──
let _insI, _delLA, _delReply, _listI, _getI, _insO, _listO, _getO;
// ── moderation tombstones (ap_rejected_objects) ───────────────────
// A reply the owner removed stays removed: its object URI is tombstoned and
// checked at ingest AND by the thread-crawler (else thread-filling would
// re-fetch it). Owner moderation acts on the LOCAL copy, so it also works for
// private notes that authorize_interaction can't fetch (401/404).
let _insRj, _hasRj;
function rjStmts() {
  if (!_insRj) {
    _insRj = db.prepare('INSERT OR IGNORE INTO ap_rejected_objects (object_uri, post_id, reason) VALUES (?,?,?)');
    _hasRj = db.prepare('SELECT 1 FROM ap_rejected_objects WHERE object_uri = ?');
  }
  return { ins: _insRj, has: _hasRj };
}
export function isRejectedObject(uri) {
  if (!uri) return false;
  try { return !!rjStmts().has.get(String(uri)); } catch { return false; }
}
// Owner removes an incoming reply: tombstone + delete. Tenancy-scoped: the
// interaction's post must belong to the caller's site.
export function rejectInteraction(site, interactionId, reason) {
  if (!site || !site.slug) return { error: 'forbidden' };
  const row = iStmts().getI.get(interactionId);
  if (!row) return { error: 'not_found' };
  const owns = db.prepare('SELECT 1 FROM posts WHERE id = ? AND site_id = (SELECT id FROM sites WHERE slug = ?)')
    .get(row.post_id, site.slug);
  if (!owns) return { error: 'forbidden' };
  if (row.object_uri) { try { rjStmts().ins.run(row.object_uri, row.post_id, reason || 'removed by site owner'); } catch { /* non-fatal */ } }
  db.prepare('DELETE FROM ap_interactions WHERE id = ?').run(interactionId);
  console.log('[AP] interaction removed by owner', site.slug, row.object_uri || row.actor_uri);
  return { ok: true, object_uri: row.object_uri || null, actor_uri: row.actor_uri || null };
}
// Stored URIs of an interaction (tenancy-scoped) → feed sendReport for flagging
// from the local copy (works for private notes; no remote fetch needed to target).
export function interactionReportTarget(site, interactionId) {
  if (!site || !site.slug) return null;
  const row = iStmts().getI.get(interactionId);
  if (!row) return null;
  const owns = db.prepare('SELECT 1 FROM posts WHERE id = ? AND site_id = (SELECT id FROM sites WHERE slug = ?)')
    .get(row.post_id, site.slug);
  if (!owns) return null;
  return { objectUri: row.object_uri || null, actorUri: row.actor_uri || null };
}

// AP addressing → visibility: 'public' | 'unlisted' | 'followers' | 'direct'.
// Mastodon-conventie: Public in `to` = public, Public in `cc` = unlisted, een
// followers-collectie zonder Public = followers-only, anders direct (DM). Public
// kan als volledige URI, 'as:Public' of 'Public' voorkomen (JSON-LD shorthands).
export function noteVisibility(o) {
  const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
  const isPub = (u) => u === PUBLIC || u === 'as:Public' || u === 'Public';
  const to = arr(o && o.to).map(String);
  const cc = arr(o && o.cc).map(String);
  if (to.some(isPub)) return 'public';
  if (cc.some(isPub)) return 'unlisted';
  if ([...to, ...cc].some((u) => /\/followers\/?$/.test(u))) return 'followers';
  return 'direct';
}

/**
 * Does this note belong in the home timeline (de Krant)?
 *
 * Only if it is a POST. A direct note is addressed to named people, so it is a
 * message: a plain DM, a ward's 🛟 help request (FEP-633c 5.2.1) or a
 * guardian's wave. Those are stored as mentions instead and surface in
 * Berichten and the Guardian PWA. A reply belongs to its thread, not the feed.
 */
export function belongsInTimeline(o) {
  if (!o || !o.id || o.inReplyTo) return false;
  return noteVisibility(o) !== 'direct';
}

function iStmts() {
  if (!_insI) {
    _insI = db.prepare('INSERT OR IGNORE INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, parent_uri, visibility, emoji_json, actor_emoji_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delLA = db.prepare('DELETE FROM ap_interactions WHERE kind = ? AND post_id = ? AND actor_uri = ?');
    _delReply = db.prepare("DELETE FROM ap_interactions WHERE kind = 'reply' AND object_uri = ?");
    _listI = db.prepare('SELECT id, kind, object_uri, parent_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, created_at, acted_boost, acted_like, visibility, emoji_json, actor_emoji_json FROM ap_interactions WHERE post_id = ? ORDER BY created_at ASC');
    _getI = db.prepare('SELECT * FROM ap_interactions WHERE id = ?');
    _insO = db.prepare('INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, language, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listO = db.prepare('SELECT * FROM ap_outbox WHERE post_id = ? ORDER BY created_at ASC');
    _getO = db.prepare('SELECT * FROM ap_outbox WHERE id = ?');
  }
  return { ins: _insI, delLA: _delLA, delReply: _delReply, list: _listI, getI: _getI, insO: _insO, listO: _listO, getO: _getO };
}

export function getInteractionById(id) { return iStmts().getI.get(id); }
export function setInteractionBoosted(id, on) {
  db.prepare('UPDATE ap_interactions SET acted_boost = ? WHERE id = ?').run(on ? 1 : 0, id);
}
export function setInteractionLiked(id, on) {
  db.prepare('UPDATE ap_interactions SET acted_like = ? WHERE id = ?').run(on ? 1 : 0, id);
}
// Your like/boost state on a REMOTE post (interact page toggles).
export function setMyReaction(slug, uri, kind, on) {
  if (on) db.prepare('INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind) VALUES (?,?,?)').run(slug, uri, kind);
  else db.prepare('DELETE FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ? AND kind = ?').run(slug, uri, kind);
}
export function getMyReactions(slug, uri) {
  const rows = (slug && uri) ? db.prepare('SELECT kind FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ?').all(slug, uri) : [];
  return { liked: rows.some((r) => r.kind === 'like'), boosted: rows.some((r) => r.kind === 'boost') };
}

const localPostExists = (id) => { try { return !!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id); } catch { return false; } };
// Extract our local post id from a note URL, but only if it's ours (base match).
// One host, two spellings (Barts WebFinger-les, 2-8): a URL the client hands
// back may carry the punycoded host (every URL parser silently punycodes)
// while PUBLIC_BASE_URL carries the typed one. WHATWG URL does the IDNA, so
// compare origins in ASCII and never the bytes the client happened to send.
function asciiOrigin(u) {
  try { const x = new URL(String(u)); return `${x.protocol}//${x.host}`.toLowerCase(); } catch { return null; }
}
function isOwnUrl(u) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return false;
  const a = asciiOrigin(u);
  return !!a && a === asciiOrigin(base);
}
function postIdFromNoteUrl(url, base) {
  const s = String(url || '');
  // ASCII origins, not startsWith: xn--zz9h.example IS 🩵.example, and a
  // byte comparison read our own note as a stranger's.
  if (base) { const a = asciiOrigin(s); if (!a || a !== asciiOrigin(base)) return null; }
  const m = s.match(/\/ap\/notes\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function deriveHandle(actorUri) {
  try { const u = new URL(actorUri); const seg = u.pathname.split('/').filter(Boolean).pop() || ''; return `@${seg}@${u.host}`; } catch { return String(actorUri || ''); }
}
function actorInfo(doc, actorUri) {
  let host = ''; try { host = new URL(actorUri).host; } catch { /* keep empty */ }
  const handle = doc && doc.preferredUsername ? `@${doc.preferredUsername}@${host}` : deriveHandle(actorUri);
  const icon = doc && doc.icon ? (doc.icon.url || (Array.isArray(doc.icon) && doc.icon[0] && doc.icon[0].url)) : null;
  const name = (doc && (doc.name || doc.preferredUsername)) || handle;
  // Een AS2 `url` mag een ARRAY van Links zijn -- onze eigen buildActor doet
  // dat (profiel + RSS), en een oudere consument stringde die array tot
  // "[object Object],[object Object]" in de mention-hrefs van een hulpvraag
  // (Barts vondst, 8-8). pickLink kiest de html-Link; de kale string blijft
  // de gewone weg, en de actor-id de terugval.
  const profiel = (doc && Array.isArray(doc.url))
    ? ((pickLink(doc.url, (mt) => !mt || /html/i.test(mt)) || {}).href || safeUrl(doc.id || actorUri))
    : safeUrl((doc && (doc.url || doc.id)) || actorUri);
  return {
    name,
    handle,
    url: profiel || null,
    icon: safeUrl(icon) || null,
    // FEP-9098 custom emojis in the display name (":shortcode:"), so the byline
    // renders them. Only computed when the name actually has a shortcode.
    emojis: /:[A-Za-z0-9_+-]+:/.test(name) ? actorNameEmojis(doc) : undefined,
  };
}

// Map ":shortcode:" → image url from an actor doc's Emoji tags (for a custom-
// emoji display name). Undefined when there are none.
function actorNameEmojis(doc) {
  const arr = doc && Array.isArray(doc.tag) ? doc.tag : (doc && doc.tag ? [doc.tag] : []);
  const out = {};
  for (const t of arr) {
    if (!t || (Array.isArray(t.type) ? t.type[0] : t.type) !== 'Emoji' || typeof t.name !== 'string' || !t.icon) continue;
    const u = t.icon.url || (Array.isArray(t.icon) && t.icon[0] && t.icon[0].url);
    if (u) out[t.name] = u;
  }
  return Object.keys(out).length ? out : undefined;
}

// Given an inReplyTo note URL, find which local post the thread belongs to + the
// note being replied to (parent), so a reply-to-a-comment can be nested.
function findThreadTarget(inReplyTo, base) {
  if (!inReplyTo) return null;
  const seg = postIdFromNoteUrl(inReplyTo, base); // our /ap/notes/<id> segment (if ours)
  if (seg && localPostExists(seg)) return { post_id: seg, parent_uri: inReplyTo };
  if (seg) {
    try { const o = db.prepare('SELECT post_id FROM ap_outbox WHERE id = ?').get(seg); if (o && o.post_id) return { post_id: o.post_id, parent_uri: inReplyTo }; } catch { /* ignore */ }
  }
  try { const row = db.prepare("SELECT post_id FROM ap_interactions WHERE object_uri = ? AND kind = 'reply' LIMIT 1").get(inReplyTo); if (row && row.post_id) return { post_id: row.post_id, parent_uri: inReplyTo }; } catch { /* ignore */ }
  return null;
}

// Drop the leading @mention(s) a federated reply carries (the person being replied to),
// so a comment reads "dope tekening ouwe" instead of "@jason@jasonhacky.nl dope …".
// Keeps a leading <p> wrapper; handles mention <a> links and plain-text @user@domain.
export function stripLeadingMentions(html) {
  if (!html) return html;
  let s = String(html);
  s = s.replace(/^(\s*<p[^>]*>)?\s*(?:<a\b[^>]*>\s*@[^<]+<\/a>[  ]*)+/i, (m, p) => p || '');
  s = s.replace(/^(\s*<p[^>]*>)?\s*(?:@[\w.-]+(?:@[\w.-]+)?[  ]+)+/i, (m, p) => p || '');
  return s;
}

// View-ready threaded view of a post's fediverse activity (inbound replies +
// our outbound replies, nested), plus like/boost counts.
export function getInteractions(postId, base, site) {
  const s = iStmts();
  // Privacy: a followers-only or direct (DM) reply is addressed to people, not to the
  // public web, so it must NOT render in the public thread. It still reaches the owner
  // via notifications (post context + reference included there). Legacy rows without a
  // visibility value are treated as public. Likes/boosts stay counted (count-only).
  const rows = s.list.all(postId).filter((r) =>
    r.kind !== 'reply' || !(r.visibility === 'followers' || r.visibility === 'direct'));
  const baseClean = (base || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const postNoteId = baseClean ? `${baseClean}/ap/notes/${postId}` : null;
  // Our own (outbound) replies show the SITE identity for everyone (not "You").
  let host = ''; try { host = new URL(baseClean).host; } catch { /* ignore */ }
  const siteName = (site && (site.title || site.slug)) || '';
  const siteHandle = (site && site.slug && host) ? `@${site.slug}@${host}` : '';
  const siteUrl = baseClean ? `${baseClean}/` : '';
  const siteIcon = (site && site.profile_photo) || null;

  // Wat JIJ met deze reacties deed komt uit de tussentabel, niet meer uit
  // acted_* (shaer-ipb). Eén batch-lookup, want een drukke thread zou anders een
  // N+1 worden. De sleutel loopt door canonicalReactionUri, precies zoals aan de
  // schrijfkant -- staat dezelfde note toevallig ook in je tijdlijn, dan is het
  // één feit en niet twee knoppen die los van elkaar aan kunnen staan.
  const mijnSleutel = new Map();
  for (const r of rows) {
    if (r.kind === 'reply' && r.object_uri) mijnSleutel.set(r.object_uri, canonicalReactionUri(site && site.slug, r.object_uri));
  }
  const mijn = getReactionsFor(site && site.slug, [...mijnSleutel.values()]);
  const mijnReactie = (uri) => mijn.get(mijnSleutel.get(uri)) || { liked: false, boosted: false };

  const nodes = [];
  for (const r of rows) {
    if (r.kind !== 'reply') continue;
    const ik = mijnReactie(r.object_uri);
    nodes.push({
      noteId: r.object_uri, parent: r.parent_uri || null, mine: false, id: r.id,
      actor_uri: r.actor_uri,
      actor_name: r.actor_name, actor_handle: r.actor_handle, actor_url: r.actor_url,
      actor_icon: r.actor_icon, content: stripLeadingMentions(r.content), created_at: r.published || r.created_at,
      emoji_json: r.emoji_json, actor_emoji_json: r.actor_emoji_json,   // FEP-9098 (thread render)
      acted_boost: ik.boosted, acted_like: ik.liked,
      children: [],
    });
  }
  for (const o of s.listO.all(postId)) {
    nodes.push({
      noteId: baseClean ? `${baseClean}/ap/notes/${o.id}` : o.id, parent: o.in_reply_to || null,
      mine: true, outboxId: o.id, content: stripLeadingMentions(o.content), created_at: o.created_at,
      media: (() => { try { return o.attachments ? JSON.parse(o.attachments) : []; } catch { return []; } })(),
      actor_name: siteName, actor_handle: siteHandle, actor_url: siteUrl, actor_icon: siteIcon,
      children: [],
    });
  }

  const byId = new Map(nodes.map((n) => [n.noteId, n]));
  // Conversation partners per node (u02, the reply editor's mentions bar): the
  // node's author plus the ancestor authors up the chain. Our own nodes are
  // skipped (we do not mention ourselves), deduped by actor, capped at 8.
  for (const n of nodes) {
    const seen = new Set();
    const list = [];
    let cur = n, guard = 0;
    while (cur && guard++ < 12 && list.length < 8) {
      if (!cur.mine && cur.actor_uri && !seen.has(cur.actor_uri)) {
        seen.add(cur.actor_uri);
        list.push({
          uri: cur.actor_uri,
          url: cur.actor_url || cur.actor_uri,
          handle: cur.actor_handle || deriveHandle(cur.actor_uri),
        });
      }
      cur = cur.parent ? byId.get(cur.parent) : null;
    }
    n.participants = list;
  }
  const isTop = (n) => !n.parent || n.parent === postNoteId || !byId.has(n.parent);
  const tops = [];
  for (const n of nodes) {
    if (isTop(n)) { tops.push(n); continue; }
    let anc = n, guard = 0;
    while (!isTop(anc) && guard++ < 12) anc = byId.get(anc.parent);
    anc.children.push(n);
  }
  const byTime = (a, b) => new Date(a.created_at) - new Date(b.created_at);
  tops.sort(byTime).forEach((t) => t.children.sort(byTime));

  return {
    thread: tops,
    likeCount: rows.filter((r) => r.kind === 'like').length,
    announceCount: rows.filter((r) => r.kind === 'announce').length,
    total: nodes.length,
  };
}

// ── HTTP Signatures + delivery ────────────────────────────────────
const slugFromActorUrl = (url) => { const m = String(url || '').match(/\/ap\/users\/([^/?#]+)/); return m ? decodeURIComponent(m[1]) : null; };
// Which of OUR sites are named in a note's Mention tags? Only hrefs on our own base count
// (an /ap/users/<slug> path on a remote host is someone else's actor), and the slug must be
// an existing site. Deduped.
export function localMentionSlugs(tags, base) {
  if (!base) return [];
  const out = [], seen = new Set();
  for (const t of (Array.isArray(tags) ? tags : (tags ? [tags] : []))) {
    if (!t || t.type !== 'Mention' || typeof t.href !== 'string') continue;
    if (!t.href.startsWith(base + '/ap/users/')) continue;
    const slug = slugFromActorUrl(t.href);
    if (!slug || seen.has(slug)) continue; seen.add(slug);
    try { if (db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(slug)) out.push(slug); } catch { /* ignore */ }
  }
  return out;
}

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
const DELIVERY_MAX_ATTEMPTS = 6;
const DELIVERY_BACKOFF_MIN = [1, 5, 15, 60, 180, 360];
let _insDeliv, _dueDeliv, _delDeliv, _bumpDeliv;
function deliveryStmts() {
  if (!_insDeliv) {
    _insDeliv = db.prepare('INSERT INTO ap_delivery (slug, inbox, body, attempts, next_at) VALUES (?,?,?,0,CURRENT_TIMESTAMP)');
    _dueDeliv = db.prepare("SELECT * FROM ap_delivery WHERE datetime(next_at) <= datetime('now') ORDER BY next_at LIMIT 30");
    _delDeliv = db.prepare('DELETE FROM ap_delivery WHERE id = ?');
    _bumpDeliv = db.prepare('UPDATE ap_delivery SET attempts = ?, next_at = ? WHERE id = ?');
  }
  return { ins: _insDeliv, due: _dueDeliv, del: _delDeliv, bump: _bumpDeliv };
}
export function enqueueDelivery(slug, inbox, activity) {
  if (!slug || !inbox || !activity) return;
  try { deliveryStmts().ins.run(slug, inbox, JSON.stringify(activity)); } catch { /* ignore */ }
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
// Deliver now; queue for retry if it fails.
export async function deliverWithRetry(slug, inbox, activity, keyId, privPem) {
  if (!inbox) return;
  try { const st = await deliver(inbox, activity, keyId, privPem); if (st >= 200 && st < 300) { markFollowerDelivery(slug, inbox, true); return; } } catch { /* queue below */ }
  enqueueDelivery(slug, inbox, activity);
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
    for (const row of rows) {
      let ok = false;
      try {
        const keys = getOrCreateKeys(row.slug);
        const st = await deliver(row.inbox, JSON.parse(row.body), `${actorId(base, row.slug)}#main-key`, keys.private_pem);
        ok = st >= 200 && st < 300;
      } catch { ok = false; }
      if (ok) { markFollowerDelivery(row.slug, row.inbox, true); deliveryStmts().del.run(row.id); continue; }
      const attempts = row.attempts + 1;
      if (attempts >= DELIVERY_MAX_ATTEMPTS) { markFollowerDelivery(row.slug, row.inbox, false); deliveryStmts().del.run(row.id); console.warn('[AP] delivery gave up after', attempts, 'tries →', row.inbox); continue; }
      // Index the backoff on the CURRENT attempt count (row.attempts) so the first
      // retry uses the 1-min tier instead of skipping it.
      const mins = DELIVERY_BACKOFF_MIN[Math.min(row.attempts, DELIVERY_BACKOFF_MIN.length - 1)];
      deliveryStmts().bump.run(attempts, new Date(Date.now() + mins * 60000).toISOString(), row.id);
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
function anySigningSlug() {
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

// ── Authorized fetch for a single Note (2-8) ─────────────────────
// Who may read this post's Note over AP GET? 'public' needs nobody;
// friends-only (fan_only, Shaer's DEFAULT) needs a verified follower;
// 'direct' is addressed to people and is never served over a GET at all.
export function noteAudience(post) {
  if (!post) return 'direct';
  if (post.ap_visibility === 'direct') return 'direct';
  if (post.fan_only || post.ap_visibility === 'friends') return 'followers';
  return 'public';
}
// A follower earns the friends-only Note; a blocked actor gets the same
// nothing as a stranger (the standing rule: a blocked actor's signed fetch
// earns the empty set, gated server-side at serialisation).
export function mayReadNote(site, post, actorUri) {
  const aud = noteAudience(post);
  if (aud === 'public') return true;
  if (aud === 'direct' || !site || !actorUri) return false;
  // FEP-1580: dezelfde regel als in outboxAudience, en hier net zo hard nodig.
  // De outbox geeft de LIJST vrij; zonder deze tak strandt de doelinstantie
  // alsnog op elke losse Note die niet publiek is.
  if (isMoveTarget(site.slug, actorUri)) return true;
  try {
    const blocked = db.prepare("SELECT 1 FROM ap_blocks WHERE slug = ? AND kind = 'actor' AND target = ?").get(site.slug, actorUri);
    if (blocked) return false;
    let host = null; try { host = new URL(actorUri).host; } catch { /* geen host, geen domein-block */ }
    if (host) {
      const dom = db.prepare("SELECT 1 FROM ap_blocks WHERE slug = ? AND kind = 'domain' AND target = ?").get(site.slug, host);
      if (dom) return false;
    }
    return !!db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(site.slug, actorUri);
  } catch { return false; }
}

// Parse a fediverse poll (an ActivityStreams `Question` — the Mastodon-standard poll form)
// into our compact shape. `oneOf` = single choice, `anyOf` = multiple; each option is a Note
// with a `name` and a `replies` collection whose `totalItems` is that option's vote count.
function parsePoll(o) {
  if (!o || o.type !== 'Question') return null;
  const raw = Array.isArray(o.oneOf) ? o.oneOf : (Array.isArray(o.anyOf) ? o.anyOf : null);
  if (!raw || !raw.length) return null;
  const options = raw.slice(0, 12).map((opt) => ({
    name: String((opt && opt.name) || '').slice(0, 300),
    count: Math.max(0, Number(opt && opt.replies && opt.replies.totalItems) || 0),
  })).filter((x) => x.name);
  if (!options.length) return null;
  const endTime = o.endTime || (typeof o.closed === 'string' ? o.closed : null);
  const closed = !!o.closed || (endTime ? Date.parse(endTime) <= Date.now() : false);
  return { multiple: Array.isArray(o.anyOf), options, endTime, closed, voters: Number(o.votersCount) || null, voted: null };
}

// ── Polls WE host (a local post with a poll) ──────────────────────
// Parse the poll definition stored on our own post (posts.poll_json). Counts are
// NOT stored here — they're derived from the poll_votes ballots so a re-render always
// reflects the authoritative tally.
export function parseOwnPoll(pollJson) {
  if (!pollJson) return null;
  let d; try { d = typeof pollJson === 'string' ? JSON.parse(pollJson) : pollJson; } catch { return null; }
  if (!d || !Array.isArray(d.options)) return null;
  const options = d.options.map((o) => ({ name: String((o && o.name != null ? o.name : o) || '').slice(0, 300) })).filter((o) => o.name);
  if (options.length < 2) return null;
  const endTime = d.endTime || null;
  const closed = !!d.closed || (endTime ? Date.parse(endTime) <= Date.now() : false);
  return { multiple: !!d.multiple, options, endTime, closed };
}

// Live tally of a hosted poll from its ballots: per-option counts + unique voters.
export function pollTally(postId) {
  const counts = {}; let voters = 0;
  try {
    for (const r of db.prepare('SELECT choice, COUNT(*) AS n FROM poll_votes WHERE post_id = ? GROUP BY choice').all(postId)) counts[r.choice] = r.n;
    voters = db.prepare('SELECT COUNT(DISTINCT actor_uri) AS n FROM poll_votes WHERE post_id = ?').get(postId).n || 0;
  } catch { /* table may not exist yet */ }
  return { counts, voters };
}

// Render-ready view of a hosted poll (options with counts + percentages, totals, state).
// Voting is fediverse-only, so this is display-only on the site.
export function ownPollView(post) {
  const poll = parseOwnPoll(post && post.poll_json);
  if (!poll) return null;
  const { counts, voters } = pollTally(post.id);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const denom = poll.multiple ? voters : total; // multiple-choice %: share of voters (can sum >100%)
  const options = poll.options.map((o) => {
    const count = counts[o.name] || 0;
    return { name: o.name, count, pct: denom ? Math.round((count / denom) * 100) : 0 };
  });
  return { multiple: poll.multiple, options, total, voters, endTime: poll.endTime, closed: poll.closed };
}

// Attach the AS2 Question shape to a note built for a hosted poll. Mastodon renders a
// status with either media OR a poll (never both), so a poll federates as content +
// options with no media attachment. oneOf = single choice, anyOf = multiple.
function applyPollToNote(note, postId, poll) {
  const { counts, voters } = pollTally(postId);
  const opts = poll.options.map((o) => ({
    type: 'Note',
    name: o.name,
    replies: { type: 'Collection', totalItems: counts[o.name] || 0 },
  }));
  note.type = 'Question';
  note[poll.multiple ? 'anyOf' : 'oneOf'] = opts;
  if (poll.endTime) note.endTime = new Date(poll.endTime).toISOString();
  // Once closed, Mastodon expects a `closed` timestamp (the effective end).
  if (poll.closed) note.closed = poll.endTime ? new Date(poll.endTime).toISOString() : new Date().toISOString();
  note.votersCount = voters;
  delete note.attachment;   // media ATTACHMENTS + a poll are mutually exclusive on Mastodon
  // Keep note.image: it's the cover, which Mastodon ignores on a Question anyway
  // (same as on any Note) but Klonkt reads to show the cover in feeds/the Cirkel.
  // Deleting it stripped the cover off every boosted poll.
  return note;
}

// Record an inbound ballot on one of OUR polls. A vote arrives as a Create(Note) whose
// `name` is the chosen option and `inReplyTo` is our poll note — the Mastodon-standard
// vote form. Returns { handled } — handled=true means it was addressed to a poll (so the
// caller must NOT also store it as a reply), false means "not a poll, fall through".
function recordPollBallot(postId, actorUri, rawChoice) {
  const choice = String(rawChoice == null ? '' : rawChoice).slice(0, 300);
  if (!choice) return { handled: false };
  let post; try { post = db.prepare('SELECT poll_json FROM posts WHERE id = ?').get(postId); } catch { return { handled: false }; }
  const poll = post && parseOwnPoll(post.poll_json);
  if (!poll) return { handled: false };               // not a poll → let the reply logic handle it
  if (poll.closed) return { handled: true };          // voting closed → drop
  if (!poll.options.some((o) => o.name === choice)) return { handled: true }; // unknown option → drop
  try {
    // Single choice = one ballot per actor: ignore a later/different vote. Multiple choice
    // allows one ballot per distinct option (the UNIQUE(post,actor,choice) dedupes repeats).
    if (!poll.multiple && db.prepare('SELECT 1 FROM poll_votes WHERE post_id = ? AND actor_uri = ? LIMIT 1').get(postId, actorUri)) return { handled: true };
    db.prepare('INSERT OR IGNORE INTO poll_votes (post_id, actor_uri, choice) VALUES (?, ?, ?)').run(postId, actorUri, choice);
  } catch { return { handled: true }; }
  schedulePollUpdate(postId);
  return { handled: true };
}

// Coalesce a burst of votes into ONE Update(Question) per poll: the first vote schedules a
// refresh ~15s out; further votes in that window ride the same pending update (which carries
// the accumulated tally). Non-follower voters re-fetch the Question (live tally) themselves.
const _pollUpdTimers = new Map();
function schedulePollUpdate(postId) {
  if (_pollUpdTimers.has(postId)) return;
  const t = setTimeout(() => { _pollUpdTimers.delete(postId); deliverPollUpdate(postId).catch(() => { /* best-effort */ }); }, 15000);
  if (t.unref) t.unref();
  _pollUpdTimers.set(postId, t);
}

// Push the fresh poll tally (or closed state) to followers as Update(Question).
export async function deliverPollUpdate(postId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !postId) return;
  let post, site;
  try {
    post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!post || !post.poll_json) return;
    site = db.prepare('SELECT * FROM sites WHERE id = ?').get(post.site_id);
  } catch { return; }
  if (site) await deliverUpdate(site, post);
}

// ── Web push to the owner (docs/webpush-design.md, slice 3) ─────────
// Fire-and-forget: a notification must never block or break inbox processing.
function pushEvent(slug, event) {
  try { Push.notifySite(slug, event).catch(() => {}); } catch { /* never throw */ }
  wakeNews(slug);   // long-poll waiters (Robins verzoek, 31-7): same moments as push
}

// ── Long-poll on news (Robins verzoek, 31-7) ─────────────────────
// The app holds GET /ap/users/:slug/inbox/wait open; the moment anything
// push-worthy lands for that account (a message, a reply, a wave, a help
// request) every waiter is woken and the app re-reads its feed. In-process
// on purpose: one Klonkt is one process, and a waiter is one callback.
const _newsWaiters = new Map();   // slug -> Set<cb>
export function onNews(slug, cb) {
  let set = _newsWaiters.get(slug);
  if (!set) { set = new Set(); _newsWaiters.set(slug, set); }
  set.add(cb);
  return () => { set.delete(cb); if (!set.size) _newsWaiters.delete(slug); };
}
/**
 * Wachters op het Guardian-paneel (Barts opdracht, 9-8).
 *
 * APART VAN onNews, en dat is met opzet. `news` gaat over de tijdlijn; dit gaat
 * over alles wat een guardian te VERWERKEN krijgt -- een aanbod, een
 * volgverzoek, een gate-voorstel, een hulpvraag, een lapse. De guardianship-
 * module zendt daar al veertien soorten voor uit; die gingen alleen naar push,
 * en push kiest bewust maar een handvol. Het paneel moet ze allemaal weten.
 *
 * Een wachter wordt EEN keer gewekt en daarna vergeten: het antwoord dat volgt
 * is de nieuwe waarheid, en de client komt terug met een nieuwe wachter.
 */
const _guardWaiters = new Map();   // slug -> Set<cb>
export function onGuardian(slug, cb) {
  let set = _guardWaiters.get(slug);
  if (!set) { set = new Set(); _guardWaiters.set(slug, set); }
  set.add(cb);
  return () => { set.delete(cb); if (!set.size) _guardWaiters.delete(slug); };
}
export function wakeGuardian(slug) {
  const set = _guardWaiters.get(slug);
  if (!set || !set.size) return;
  const cbs = [...set];
  set.clear();
  _guardWaiters.delete(slug);
  for (const cb of cbs) { try { cb(); } catch { /* een wachter mag de rest nooit breken */ } }
}

export function wakeNews(slug) {
  const set = _newsWaiters.get(slug);
  if (!set || !set.size) return;
  const cbs = [...set];
  set.clear();
  _newsWaiters.delete(slug);
  for (const cb of cbs) { try { cb(); } catch { /* a waiter must never break the rest */ } }
}
// Path prefix for a site's pages. One instance is one owner, so the site
// lives at the root; kept as a function because the push URLs read like
// `${pushPrefix(slug)}/messages` all over this file.
function pushPrefix() { return ''; }
// Notification language: the site's content language (fallback: instance default).
function pushLang(slug) {
  try { const r = db.prepare('SELECT language FROM sites WHERE slug = ?').get(slug); return (r && r.language) || process.env.KLONKT_DEFAULT_LANG || 'nl'; } catch { return 'nl'; }
}
// Site slug, target URL and title for a post-scoped notification.
function pushPostCtx(postId) {
  try {
    const r = db.prepare('SELECT p.slug AS post, p.title, s.slug AS site FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ?').get(postId);
    if (!r) return null;
    return { site: r.site, title: r.title || r.post, url: `${pushPrefix(r.site)}/${r.post}#fediverse` };
  } catch { return null; }
}

/**
 * Een DOORGESTUURDE activiteit alsnog verifiëren (shaer-s8k).
 *
 * Reageert iemand in een thread, dan stuurt de server van de oorspronkelijke
 * poster die reactie door naar de deelnemers -- en ondertekent met zijn EIGEN
 * sleutel. De handtekening klopt dan, maar de ondertekenaar is niet de auteur,
 * dus de gate hieronder wees hem af. Gevolg: reacties van derden kwamen niet
 * binnen, zonder dat iemand een fout zag.
 *
 * Mastodon lost dit op met een LD-Signature over de payload. Dat vraagt
 * JSON-LD-canonicalisatie; wij doen het lichter en strenger: we geloven de
 * bezorgde inhoud NIET en halen het object op bij de bron.
 *
 * Vier voorwaarden, en geen ervan is optioneel:
 *
 *  1. Alleen Create en Update. Een doorgestuurde Delete is per definitie niet te
 *     dereferencen -- het object is weg -- dus die blijft geweigerd.
 *  2. De host van de object-id MOET die van de geclaimde actor zijn. Zonder dit
 *     anker wijst een doorsturer je naar een host die hij zelf beheert, waar
 *     attributedTo alles kan beweren.
 *  3. Het OPGEHAALDE object wordt gebruikt, niet de bezorgde payload. Anders
 *     levert een doorsturer een echt id met verdraaide inhoud.
 *  4. Mislukt het ophalen, of wijst het object zichzelf niet toe aan de
 *     geclaimde actor, dan blijft het een weigering. Geen twijfelgeval opslaan.
 */
/** Kennen we deze note? Een eigen post, een eigen outbox-antwoord, een
 *  gecachete post in de tijdlijn, of een reactie die al in een thread van ons
 *  staat. Alle vier zijn een geldige reden dat iemand ons een antwoord daarop
 *  doorstuurt; iets anders is dat niet. */
function knownNoteUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  try {
    if (base && uri.startsWith(`${base}/ap/notes/`)) {
      const seg = decodeURIComponent(uri.slice(`${base}/ap/notes/`.length).split(/[?#]/)[0]);
      if (db.prepare('SELECT 1 FROM ap_outbox WHERE id = ?').get(seg)) return true;
      if (db.prepare('SELECT 1 FROM posts WHERE id = ?').get(seg)) return true;
    }
    if (db.prepare('SELECT 1 FROM ap_timeline WHERE id = ? LIMIT 1').get(uri)) return true;
    if (db.prepare('SELECT 1 FROM ap_interactions WHERE object_uri = ? LIMIT 1').get(uri)) return true;
    // Een antwoord dat we al bezorgd kregen van iemand die we volgen (shaer-e9g).
    if (db.prepare('SELECT 1 FROM ap_seen_notes WHERE uri = ? LIMIT 1').get(uri)) return true;
  } catch { /* bij twijfel niet ophalen */ }
  return false;
}

/**
 * Onthoud dat we dit bericht al eens bezorgd kregen.
 *
 * Alleen de URI. Geen inhoud, niets op het scherm, geen tweede weergave -- dit
 * beantwoordt uitsluitend de vraag "kennen wij dit bericht?" die knownNoteUri
 * stelt voordat er iets bij de bron wordt opgehaald.
 *
 * De beller bepaalt WIE er onthouden wordt, en dat is de hele veiligheidsvraag:
 * onthouden we zomaar alles wat iemand aflevert, dan kan een vreemde eerst een
 * bericht neerleggen en daarna met een doorgestuurd antwoord dáárop ons naar een
 * adres van zijn keuze sturen. Vandaar dat handleInbox dit alleen doet voor
 * schrijvers die je zelf volgt.
 */
const SEEN_NOTES_DAYS = 30;
let _seenSinceSnoei = 0;
function rememberNoteUri(uri) {
  if (!uri || typeof uri !== 'string') return;
  try {
    db.prepare('INSERT OR IGNORE INTO ap_seen_notes (uri) VALUES (?)').run(uri);
    // Af en toe opruimen, niet bij het opstarten: een server die weken doorloopt
    // zou anders nooit snoeien. Doorsturen gebeurt kort na het antwoord, dus wat
    // ouder is dan een maand beantwoordt geen enkele vraag meer.
    if (++_seenSinceSnoei >= 500) {
      _seenSinceSnoei = 0;
      const r = db.prepare(`DELETE FROM ap_seen_notes WHERE created_at < datetime('now', '-${SEEN_NOTES_DAYS} days')`).run();
      if (r.changes) console.log(`[AP] seen notes: ${r.changes} pruned`);
    }
  } catch { /* niet fataal */ }
}
const isFollowedActor = (uri) => {
  try { return !!db.prepare('SELECT 1 FROM ap_following WHERE actor_uri = ? LIMIT 1').get(uri); } catch { return false; }
};

// Mislukte dereferences kort onthouden. Mastodon herhaalt een bezorging
// dagenlang; zonder dit doet elke herhaling de fetch opnieuw, ook als die de
// vorige twintig keer niets opleverde. Dempt meteen de scherpte van misbruik.
const _derefMiss = new Map();
const DEREF_MISS_MS = 30 * 60 * 1000;
function derefRecentlyFailed(uri) {
  const t = _derefMiss.get(uri);
  if (t === undefined) return false;
  if (Date.now() - t > DEREF_MISS_MS) { _derefMiss.delete(uri); return false; }
  return true;
}
function noteDerefFailure(uri) {
  if (_derefMiss.size > 500) {   // simpele begrenzing: oudste helft eruit
    const oud = [..._derefMiss.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
    for (const [k] of oud) _derefMiss.delete(k);
  }
  _derefMiss.set(uri, Date.now());
}

async function dereferenceForwarded(act, claimedActor, type, slugParam) {
  // Every exit states its reason. Five of the six used to return silently, so a
  // rejection count could not be told apart from a narrowing that closed too far
  // — and that is exactly the measurement shaer-drf is waiting for. Bounded by
  // the signer-mismatch rate (tens per hour), so this is not a noisy log.
  const skipped = (reason, detail) => {
    console.log(`[AP] inbox forwarded, skipped (${reason}):`, claimedActor, detail || '');
    return null;
  };
  if (type !== 'Create' && type !== 'Update') return skipped('not Create/Update', type);
  const o = act && act.object;
  const objId = typeof o === 'string' ? o : (o && o.id);
  if (!objId || typeof objId !== 'string' || !/^https:\/\//i.test(objId)) return skipped('no https object id', objId || '(none)');
  try {
    if (new URL(objId).host !== new URL(claimedActor).host) return skipped('host anchor', objId);   // ankereis
  } catch { return skipped('unparsable id', objId); }
  // Alleen dereferencen als het object beweert een antwoord te zijn op iets van
  // ONS (shaer-drf). Zonder die eis zijn claimedActor en object.id allebei door
  // de aanvaller gekozen en eist het host-anker alleen dat ze aan elkaar gelijk
  // zijn -- dan kan iedereen met een werkende actor ons naar elke URL sturen.
  // Doorsturen bestaat juist omdát wij in de thread zitten, dus deze eis kost
  // niets aan legitiem verkeer waarvan we de ouder kennen.
  const parent = typeof o === 'object' && o
    ? (typeof o.inReplyTo === 'string' ? o.inReplyTo : (o.inReplyTo && o.inReplyTo.id))
    : null;
  if (!knownNoteUri(parent)) return skipped('unknown inReplyTo', parent || '(none)');
  if (derefRecentlyFailed(objId)) return skipped('recent failure', objId);
  // Onbetekend eerst; tekenen alleen als terugval. Anders kan een ander ons een
  // ONDERTEKEND verzoek naar een adres van zijn keuze laten sturen -- dezelfde
  // reden als bij fetchActor sinds efe5633.
  let fetched = await apGetJson(objId).catch(() => null);
  if (!fetched || fetched.id !== objId) {
    // The signer used to be slugParam, which is null on the shared inbox — and
    // that is where forwarded traffic lands, because we advertise a sharedInbox.
    // signedGetJson falls back to an unsigned GET for a null slug, so a source in
    // secure mode could never be dereferenced at all. Same fix verifyRequest got
    // in shaer-afq: any local actor is a valid signer.
    const asSlug = slugParam || anySigningSlug();
    if (asSlug) fetched = await signedGetJson(asSlug, objId).catch(() => null);
  }
  const attributed = fetched && (typeof fetched.attributedTo === 'string'
    ? fetched.attributedTo
    : (fetched.attributedTo && fetched.attributedTo.id));
  if (!fetched || fetched.id !== objId) {
    noteDerefFailure(objId);
    return skipped('fetch failed', objId);
  }
  if (attributed !== claimedActor) {
    // Not a transport hiccup: the source itself says someone else wrote this.
    noteDerefFailure(objId);
    return skipped('attributedTo mismatch', `${objId} claims ${attributed || '(none)'}`);
  }
  return fetched;
}

// Handle an incoming inbox POST. slugParam = null for the shared /ap/inbox.
export async function handleInbox(req, slugParam, preVerified = null) {
  const act = req.body || {};
  const type = act.type;
  // Real client IP (behind the proxy via `trust proxy`) — logged on dropped/rejected/
  // ignored inbox hits so an operator can see who is probing their fediverse inbox.
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || '?';
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  // preVerified is the loopback (see deliverToActor): a delivery between two
  // actors on THIS instance never crosses a socket, so there is no signature to
  // check — but we do know who signed, because we signed it. Handing that in
  // keeps everything below identical, including the actor-versus-signer check,
  // which is exactly the check that must not be skipped for being local.
  const verified = preVerified || await verifyRequest(req, slugParam).catch(() => null);

  // ENFORCE HTTP signatures: a data-affecting activity must be signed by the very
  // actor it claims to be. No valid signature, or signer ≠ actor → reject (no
  // forged replies/likes/follows/timeline posts). GET/discovery stays open.
  const claimedActor = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  // Blocked actor/domain → silently drop (202, don't reveal the block).
  if (claimedActor && isBlockedAny(claimedActor)) { console.log('[AP] inbox dropped (blocked)', claimedActor, 'from', ip); return 202; }
  const GATED = ['Create', 'Like', 'Announce', 'Follow', 'Delete', 'Undo', 'Accept', 'Reject', 'Add', 'Remove', 'Update', 'Flag', 'Offer', 'Move'];
  if (GATED.includes(type)) {
    // Een geldige handtekening van iemand anders dan de auteur is doorsturen,
    // geen vervalsing. Haal het object dan bij de bron op in plaats van het af
    // te wijzen; lukt dat niet, dan valt het door naar de weigering hieronder.
    let forwarded = null;
    if (verified && claimedActor && verified.id !== claimedActor) {
      forwarded = await dereferenceForwarded(act, claimedActor, type, slugParam).catch(() => null);
      if (forwarded) {
        act.object = forwarded;   // de OPGEHAALDE inhoud, niet de bezorgde
        console.log('[AP] inbox forwarded, verified at the source:', type, claimedActor, 'via', verified.id);
      }
    }
    if (!forwarded && (!verified || !claimedActor || verified.id !== claimedActor)) {
      // Drie verschillende oorzaken, die eerder allemaal "unsigned/invalid"
      // heetten: geen handtekening meegestuurd, wel een handtekening maar niet
      // te verifiëren (meestal een opgeheven account waarvan de sleutel weg is),
      // of geldig ondertekend door iemand anders.
      const reden = verified ? '(signer mismatch)'
        : (req.headers && req.headers.signature) ? '(signature present, unverifiable)'
        : '(no signature)';
      console.warn('[AP] inbox REJECTED (signature)', type, claimedActor || '?', 'from', ip, reden);
      return 401;
    }
    // One answer restores everything (FEP-633c 3.6): any VERIFIED activity
    // from an actor that guards someone here restores it to active for those
    // wards and cancels any lapse running against it, before the activity is
    // even looked at. Signature-gated on purpose: an unverified claim of
    // being gran must not wake gran up.
    try {
      const ev = Guardianship.availability.oneAnswer(claimedActor, Date.now());
      if (ev.restored.length) console.log('[AP] guardian restored (one answer, 3.6):', claimedActor, '→', ev.restored.join(', '));
      for (const c of ev.cancelledLapses) console.log('[AP] lapse cancelled by an answer from its target:', c.id);
    } catch { /* availability is never load-bearing for delivery */ }
  }

  // FEP-633c §5.3 (modelled on the adoption offer): a gated follow forwarded to
  // the guardians as an Offer(Follow), their Accept/Reject back to the ward.
  if ((type === 'Offer' || type === 'Accept' || type === 'Reject') && act['shaer:followApproval'] === true) {
    if (await handleFollowApprovalInbox(act, slugParam)) { console.log('[AP] follow-approval', type, 'from', claimedActor); return 202; }
  }

  // FEP-633c: the adoption handshake. An Offer lands at the local ward; an
  // Accept/Reject answers an offer a local guardian sent. Anything the
  // guardianship module does not recognize falls through to the old paths.
  // An Undo of the guardianship Relationship (§3.2) is handled here too, and it
  // must be seen BEFORE the generic Undo branch below, which only knows about
  // Follow/Like/Announce and would swallow it with a 202.
  if (type === 'Offer' || type === 'Accept' || type === 'Reject' || (type === 'Undo' && Guardianship.parseUndoRelationship(act))) {
    // Every LOCAL party this activity is addressed to gets its own copy of the
    // handshake (a ward and a co-guardian may both live here). Gather candidate
    // local slugs from the inbox owner, the `to` list, and the ward.
    // MET localSlugOf en niet met slugFromActorUrl. Dat laatste knipt alleen de
    // staart van een pad af, zonder naar de HOST te kijken -- en deze uri's
    // komen uit `to` en uit de relatie, dus van de afzender. Een Offer gericht
    // aan https://elders.example/ap/users/dev leverde zo de slug "dev" op, en
    // die bestaat hier. Dan draait onze dev de afhandeling van een activiteit
    // die nooit aan hem geadresseerd was. localSlugOf eist dat de uri met onze
    // eigen basis begint en dat de site echt bestaat.
    const cand = new Set();
    if (slugParam) cand.add(slugParam);
    for (const t of (Array.isArray(act.to) ? act.to : (act.to ? [act.to] : []))) {
      if (typeof t === 'string') { const s = localSlugOf(t); if (s) cand.add(s); }
    }
    if (type === 'Offer' || type === 'Undo') {
      const rel = type === 'Undo' ? Guardianship.parseUndoRelationship(act) : Guardianship.parseRelationship(act.object);
      if (rel) { const s = localSlugOf(rel.ward); if (s) cand.add(s); }
    }
    let consumed = false;
    for (const slug of cand) {
      const gsite = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
      if (gsite && await Guardianship.handleGuardianshipInbox(gsite, act).catch(() => false)) consumed = true;
    }
    if (consumed) { console.log('[AP] guardianship', type, 'from', claimedActor); return 202; }
  }

  // A moderation report (Flag) about our content — store it for the targeted site's owner
  // (each Klonkt site is moderated by its own owner). Signature is enforced (GATED).
  if (type === 'Flag') {
    const objs = Array.isArray(act.object) ? act.object : (act.object ? [act.object] : []);
    const objectUris = objs.map((o) => (typeof o === 'string' ? o : (o && o.id))).filter(Boolean);
    let targetSlug = null;
    const noteIds = [];
    for (const u of objectUris) {
      const s = localSlugOf(u);             // one of OURS -- host meegewogen
      if (s) { targetSlug = targetSlug || s; continue; }
      const pid = postIdFromNoteUrl(u, base); // one of our notes?
      if (pid) noteIds.push(pid);
    }
    if (!targetSlug && noteIds.length) {
      try { const r = db.prepare('SELECT s.slug FROM posts p JOIN sites s ON s.id = p.site_id WHERE p.id = ? LIMIT 1').get(noteIds[0]); if (r) targetSlug = r.slug; } catch { /* ignore */ }
    }
    if (!targetSlug) return 202; // not about us / can't tell → drop
    // Flag is GATED, so `verified` is the signer's (reporter's) actor doc already.
    const ai = actorInfo(verified || null, claimedActor);
    try {
      db.prepare('INSERT INTO ap_reports (slug, actor_uri, actor_name, actor_handle, actor_icon, content, objects, created_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
        .run(targetSlug, claimedActor || null, ai.name, ai.handle, ai.icon, HtmlSanitizerService.toPlainText(act.content || '').slice(0, 3000), JSON.stringify(objectUris.slice(0, 20)));
      console.log('[AP] report received for', targetSlug, 'from', claimedActor);
    } catch { /* ignore */ }
    return 202;
  }

  // FEP-7628 (DRAFT): an account moved house. Handled before Follow on purpose:
  // a Move often arrives seconds before the new actor's re-Follow wave, and the
  // swap below must not race our own outgoing Follow of the target.
  if (type === 'Move') {
    return handleMoveInbox(act, { verifiedActor: claimedActor });
  }

  if (type === 'Follow') {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    // EERST: volgt iemand onze BIBLIOTHEEK in plaats van onze actor? (shaer-0nh)
    //
    // Een luisteraar krijgt de muziek en NIET de gewone posts -- wie zich
    // abonneert op een platenkast heeft niet om de Krant gevraagd. Vandaar een
    // eigen tabel: zolang ze daar staan kan een postbezorging ze niet per
    // ongeluk meenemen.
    //
    // De bibliotheek is openbaar (alles erin is fedi_open), dus dit accepteert
    // meteen. Er valt niets goed te keuren, en dan is wachten oneerlijk.
    const libSlug = libraryOwnerSlug(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (who && libSlug) {
      const remote = await fetchActor(who);
      if (!remote || !remote.inbox) return 202;
      const fi = actorInfo(remote, who);
      luisteraars.voegToe(libSlug, {
        actorUri: who, inbox: remote.inbox,
        sharedInbox: (remote.endpoints && remote.endpoints.sharedInbox) || null,
        name: fi.name, handle: fi.handle, icon: fi.icon,
      });
      const keys = getOrCreateKeys(libSlug);
      const accept = {
        '@context': AP_CONTEXT,
        id: `${actorId(base, libSlug)}#accept-library-${Date.now()}-${rid()}`,
        type: 'Accept', actor: actorId(base, libSlug), object: act,
      };
      deliver(remote.inbox, accept, `${actorId(base, libSlug)}#main-key`, keys.privatePem)
        .catch(() => { /* de volger staat er; een mislukte Accept mag dat niet omgooien */ });
      console.log('[AP] library follow from', who, '->', libSlug);
      return 202;
    }
    // slugParam is de eigenaar van een per-actor inbox; op de GEDEELDE inbox is
    // die er niet en werd de slug uit act.object geraden. Zonder hostcontrole
    // kon een Follow op andermans actor met dezelfde padstaart hier een volger
    // opleveren.
    const slug = slugParam || localSlugOf(typeof act.object === 'string' ? act.object : (act.object && act.object.id));
    if (!who || !slug) return 400;
    const remote = await fetchActor(who);
    if (!remote || !remote.inbox) return 202; // can't reach them → drop quietly
    const sharedInbox = (remote.endpoints && remote.endpoints.sharedInbox) || null;
    const fi = actorInfo(remote, who);   // cache display for the friends list (shaer-aa3)
    // FEP-633c §5.3: if the followed actor is a WARD (has guardians), the
    // follow is gated. A committed guardian's own Follow is auto-accepted
    // (it needs no gate); anyone else is held pending for guardian approval.
    // Free actors / normal sites have no guardians → fall through, unchanged.
    const wardGuardians = Guardianship.listGuardians(slug).map((g) => g.other_uri);
    if (wardGuardians.length && !wardGuardians.includes(who)) {
      const followId = (typeof act.id === 'string' && act.id) || `${who}#follow-${Date.now()}-${rid()}`;
      Guardianship.follows.recordPending(slug, {
        id: followId, follower: who, inbox: remote.inbox, sharedInbox,
        name: fi.name, handle: fi.handle, icon: fi.icon, activity: act,
      });
      // FEP-633c §5.3, modelled on the guardian offer: the ward forwards the
      // gated follow to its guardians for approval. A LOCAL guardian gets a
      // push and reads /guardian directly; a REMOTE guardian gets an
      // Offer(Follow) delivered so its instance stores a copy (same distributed
      // pattern as the adoption offer). On quorum the ward returns Accept(Follow).
      const wardActor = actorId(base, slug);
      const wardKeys = getOrCreateKeys(slug);
      const followObj = { id: followId, type: 'Follow', actor: who, object: wardActor };
      // Dormancy evidence (FEP-633c 3.6.2): this decision directly addresses
      // every guardian. The ONLY admissible evidence is a request like this
      // one going unanswered; recordRequest itself skips a declared absence.
      for (const g of wardGuardians) {
        try { Guardianship.availability.recordRequest(slug, g, followId, Date.now()); } catch { /* never load-bearing */ }
      }
      for (const g of wardGuardians) {
        // Local ONLY when the guardian lives on THIS instance: slugFromActorUrl
        // ignores the host (an /ap/users/x path on a remote host is someone
        // else's actor), so also require our base + an existing local site.
        const gslug = g.startsWith(`${base}/`) ? slugFromActorUrl(g) : null;
        const isLocal = gslug && db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(gslug);
        if (isLocal) {
          const L = pushLang(gslug);
          // Een volgverzoek is geen mede-voogdij. Deze push leende de tekst van
          // offer_for_ward en meldde dus een adoptie die niet gebeurde -- met de
          // volger als onderwerp. Eigen woorden, en allebei de namen erin: wie
          // er vraagt, en om wie het gaat (shaer-p729).
          pushEvent(gslug, { type: 'guardian', title: i18nT(L, 'push.n_guard_folin_t'), body: i18nT(L, 'push.n_guard_folin_b', { who: fi.name || fi.handle || i18nT(L, 'notif.someone'), ward: slug }), url: `${pushPrefix(gslug)}/guardian` });
        } else {
          fetchActor(g).then((ga) => {
            const inbox = ga && ((ga.endpoints && ga.endpoints.sharedInbox) || ga.inbox);
            if (!inbox) return;
            const beslissend2 = Guardianship.gated.isDecisive(0, Guardianship.follows.followThreshold(guardians.length));
            const offer = { '@context': AP_CONTEXT, id: `${wardActor}#followoffer-${Date.now()}-${rid()}`, type: 'Offer', actor: wardActor, to: [g], object: followObj, 'shaer:followApproval': true, 'shaer:decisive': beslissend2 };
            deliverWithRetry(slug, inbox, offer, `${wardActor}#main-key`, wardKeys.private_pem).catch(() => {});
          }).catch(() => {});
        }
      }
      console.log('[AP] Follow', who, '→ ward', slug, '(gated, awaiting guardians)');
      return 202;
    }
    fStmts().ins.run(slug, who, remote.inbox, sharedInbox, fi.name, fi.handle, fi.icon);
    try { _updFDisp.run(fi.name, fi.handle, fi.icon, slug, who); } catch { /* best effort */ }
    { const L = pushLang(slug); pushEvent(slug, { type: 'follow', title: i18nT(L, 'push.n_follow_t'), body: i18nT(L, 'push.n_follow_b', { who: fi.name || fi.handle || i18nT(L, 'notif.someone') }), url: `${pushPrefix(slug)}/connect` }); }
    const me = actorId(base, slug);
    const keys = getOrCreateKeys(slug);
    const accept = { '@context': AP_CONTEXT, id: `${me}#accept-${Date.now()}-${rid()}`, type: 'Accept', actor: me, object: act };
    deliver(remote.inbox, accept, `${me}#main-key`, keys.private_pem).catch((e) => console.warn('[AP] Accept delivery failed:', e.message));
    // Auto-backfill: send our recent posts as Create so the instance has our history
    // (Mastodon doesn't fetch history on follow). ONCE PER REMOTE INSTANCE only —
    // Mastodon dedupes notes per-instance, so re-filling an instance that already has
    // a follower of ours is wasted work (and won't re-populate the new follower's
    // timeline anyway). Deliver to the shared inbox (instance-level) when present.
    // Sync insert+check (no await between) → no interleave race with concurrent Follows.
    const instanceFilled = sharedInbox &&
      db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND shared_inbox = ? AND actor_uri != ? LIMIT 1')
        .get(slug, sharedInbox, who);
    if (!instanceFilled) {
      backfillNewFollower(base, slug, sharedInbox || remote.inbox).catch(() => { /* best-effort */ });
    }
    console.log('[AP] Follow', who, '→', slug, verified ? '(sig ok)' : '(sig unverified)');
    return 202;
  }
  // Een luisteraar die weggaat, hoort meteen weg te zijn.
  if (type === 'Undo' && act.object && act.object.type === 'Follow') {
    const doel = typeof act.object.object === 'string' ? act.object.object : (act.object.object && act.object.object.id);
    const libSlug = libraryOwnerSlug(doel);
    const wie = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    if (libSlug && wie && luisteraars.verwijder(libSlug, wie)) {
      console.log('[AP] library unfollow from', wie, '->', libSlug);
      return 202;
    }
  }

  if (type === 'Undo' && act.object) {
    const who = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
    const ot = act.object.type;
    if (ot === 'Follow') {
      const obj = act.object.object;
      const slug = slugParam || slugFromActorUrl(typeof obj === 'string' ? obj : (obj && obj.id));
      if (who && slug) { fStmts().del.run(slug, who); console.log('[AP] Unfollow', who, '→', slug); }
      return 202;
    }
    if (ot === 'Like' || ot === 'Announce') {
      const tgt = act.object.object;
      const pid = postIdFromNoteUrl(typeof tgt === 'string' ? tgt : (tgt && tgt.id), base);
      if (who && pid) { iStmts().delLA.run(ot.toLowerCase(), pid, who); console.log('[AP] Undo', ot, who, '→', pid); }
      return 202;
    }
    return 202;
  }

  const actorUri = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);
  const resolveActor = async (uri) => ((verified && verified.id === uri) ? verified : await fetchActor(uri).catch(() => null));
  // Our OWN activity is already stored via ap_outbox: don't store it twice.
  // "Our own" means THIS inbox's owner, not "anyone who happens to live on this
  // machine". The old reading dropped every activity between two sites on one
  // instance, so a note from a co-located guardian to its ward was accepted
  // with a 202 and then quietly thrown away: no mention, no away, no help
  // request. Neighbours are not us (Robins regel, 29-7: on this machine
  // everything behaves as if every Klonkt were somewhere else).
  const isLocalActor = !!(actorUri && slugParam && actorUri === actorId(base, slugParam));

  // Inbound reply: a Create whose object replies to one of our notes (post OR comment).
  if (type === 'Create' && act.object && TIJDLIJN_SOORTEN.has(act.object.type)) {
    const o = act.object;
    // A poll ballot: a Note carrying a `name` (the chosen option) inReplyTo one of OUR poll
    // posts. Record it (deduped per actor) BEFORE the reply logic so a vote is never stored
    // as a comment. recordPollBallot returns handled=false only if the target isn't a poll.
    if (o.name && o.inReplyTo && actorUri && !isLocalActor) {
      const seg = postIdFromNoteUrl(o.inReplyTo, base);
      if (seg && localPostExists(seg)) {
        const rec = recordPollBallot(seg, actorUri, o.name);
        if (rec.handled) { console.log('[AP] poll vote', actorUri, '→', seg); return 202; }
      }
    }
    const tgt = findThreadTarget(o.inReplyTo, base);
    if (tgt && actorUri && !isLocalActor) {
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      const html = HtmlSanitizerService.sanitize(o.content || '');
      if (isRejectedObject(o.id)) { console.log('[AP] reply skipped (tombstoned)', o.id); return 202; }
      iStmts().ins.run('reply', tgt.post_id, o.id || '', actorUri, ai.name, ai.handle, ai.url, ai.icon, html, o.published || null, tgt.parent_uri, noteVisibility(o), extractEmojiTags(o.tag), emojiJsonOf(ai.emojis));
      console.log('[AP] reply', actorUri, '→', tgt.post_id);
      // A reply is a post too: Berichten renders it the way de Krant renders a
      // timeline row, so it needs the same media and the same quote/preview card.
      {
        const where = 'kind = ? AND post_id = ? AND actor_uri = ? AND object_uri = ?';
        const key = ['reply', tgt.post_id, actorUri, o.id || ''];
        const mj = mediaFromNote(o);
        if (mj && mj !== '[]') { try { db.prepare(`UPDATE ap_interactions SET media_json = ? WHERE ${where}`).run(mj, ...key); } catch { /* ignore */ } }
        resolveCard(o).then((c) => {
          if (!c) return;
          const col = c.column === 'quote_json' ? 'quote_json' : 'embed_json';   // never a value from the wire
          try { db.prepare(`UPDATE ap_interactions SET ${col} = ? WHERE ${where}`).run(c.json, ...key); } catch { /* ignore */ }
        }).catch(() => { /* best-effort */ });
      }
      {
        // Private (followers/direct) replies push as a DM ping WITHOUT content
        // (the push service should never carry private text, design decision);
        // public replies carry a short snippet.
        const ctx = pushPostCtx(tgt.post_id);
        const vis = noteVisibility(o);
        const priv = vis === 'direct' || vis === 'followers';
        if (ctx) {
          const L = pushLang(ctx.site);
          const who = ai.name || ai.handle || i18nT(L, 'notif.someone');
          if (priv) pushEvent(ctx.site, { type: 'dm', title: i18nT(L, 'push.n_dm_t'), body: i18nT(L, 'push.n_dm_b', { who }), url: `${pushPrefix(ctx.site)}/messages` });
          else pushEvent(ctx.site, { type: 'reply', title: i18nT(L, 'push.n_reply_t', { title: ctx.title }), body: `${who}: ${HtmlSanitizerService.toPlainText(html).slice(0, 90)}`, url: ctx.url });
        }
      }
      return 202;
    }
    // Home timeline (client): a top-level post from an account we follow.
    if (actorUri && !isLocalActor && belongsInTimeline(o)) {
      let subs = []; try { subs = db.prepare('SELECT slug, auto_boost FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist yet */ }
      if (subs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const { html, atts: _atts, url: _url } = timelineFields(o);
        const media = JSON.stringify(_atts);
        const poll = parsePoll(o); // a Question (fediverse poll) → cache its options/counts
        // "Feature" = show in the Cirkel (local only). We do NOT auto-Announce
        // incoming posts to the fediverse — that flooded followers. Boosting to the
        // fediverse is only ever a deliberate, manual per-post action (the 🔁 on
        // the timeline).
        for (const s of subs) {
          tlStmts().ins.run(o.id, s.slug, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, _url, o.published || null, media, o.sensitive ? 1 : 0, contentWarning(o));
          // FEP-633c §2.2: register the ward hint on the stored object (no action yet).
          if (Guardianship.objectHasGuardians(o)) { try { db.prepare('UPDATE ap_timeline SET has_guardians = 1 WHERE id = ? AND slug = ?').run(o.id, s.slug); } catch { /* ignore */ } }
          // FEP-9098: keep the note's custom-emoji tags so the C2S inbox read can serve them.
          { const ej = extractEmojiTags(o.tag); if (ej) { try { db.prepare('UPDATE ap_timeline SET emoji_json = ? WHERE id = ? AND slug = ?').run(ej, o.id, s.slug); } catch { /* ignore */ } } }
          storeAuthorEmoji(o.id, s.slug, ai);   // custom-emoji display name for the byline

          // FEP-e232 + FEP-044f: keep the note's object-link/quote tags for the same read.
          { const lj = extractLinkJson(o); if (lj) { try { db.prepare('UPDATE ap_timeline SET link_json = ? WHERE id = ? AND slug = ?').run(lj, o.id, s.slug); } catch { /* ignore */ } } }
          if (poll) { try { db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(poll), o.id, s.slug); } catch { /* ignore */ } }
        }
        // FEP-044f embedded quote card: resolve the quoted post out of band so
        // the inbox response is not blocked on a remote fetch. Best-effort.
        if (quoteHrefOf(o)) {
          const slugs = subs.map((s) => s.slug);
          resolveQuote(o).then((qj) => {
            if (!qj) return;
            for (const sl of slugs) { try { db.prepare('UPDATE ap_timeline SET quote_json = ? WHERE id = ? AND slug = ?').run(qj, o.id, sl); } catch { /* ignore */ } }
          }).catch(() => { /* best-effort */ });
        } else {
          // No fediverse quote: try an EXTERNAL embed (oEmbed / known provider),
          // thumbnail-only. Also out of band, and stored for everyone; the gate
          // that decides who may SEE it is applied at serve time (§5.3-style
          // gated feature, see the inbox read).
          const slugs = subs.map((s) => s.slug);
          resolveExternalEmbed(o.content).then((ej) => {
            if (!ej) return;
            for (const sl of slugs) { try { db.prepare('UPDATE ap_timeline SET embed_json = ? WHERE id = ? AND slug = ?').run(ej, o.id, sl); } catch { /* ignore */ } }
          }).catch(() => { /* best-effort */ });
        }
        console.log('[AP] timeline +', actorUri, 'x' + subs.length);
      }
    }
    // Een ANTWOORD van iemand die we volgen: bewaar de URI (shaer-e9g). Zo'n
    // bericht komt hier gewoon binnen, ondertekend door de schrijver zelf, maar
    // belongsInTimeline houdt het uit de Krant en daarna raakten we het kwijt.
    // Kwam er later een doorgestuurd antwoord OP dat bericht, dan kenden we de
    // ouder niet en wezen we het af -- terwijl we hem wel degelijk hadden gehad.
    // Er verandert niets aan wat we tonen of van vreemden aannemen: de schrijver
    // moet iemand zijn die je zelf bent gaan volgen.
    if (actorUri && !isLocalActor && o.id && o.inReplyTo && noteVisibility(o) !== 'direct' && isFollowedActor(actorUri)) {
      rememberNoteUri(o.id);
    }
    // Mentioned in a post that is NOT a reply to our content (a reply to us already returned
    // above): store a mention notification for each of our actors named in the Mention tags.
    // Requires our own base prefix on the tag href — /ap/users/<slug> on a REMOTE host is
    // someone else's actor, not ours.
    // Een markering op een hulpvraag (shaer-lgo): een mede-guardian laat weten
    // dat hij ernaar kijkt, of dat het is afgehandeld. Gewone directe note met
    // een shaer:-markering, net als de zwaai -- dus die komt hier langs. VOOR de
    // mention-opslag, want dit is staat en geen bericht om te bewaren; de ward
    // krijgt hem wel als bericht te lezen, en dat gebeurt hieronder.
    if (actorUri && !isLocalActor) {
      const mark = Guardianship.help.parseMarker(o);
      if (mark) {
        const ai = actorInfo(await resolveActor(actorUri).catch(() => null), actorUri);
        Guardianship.help.record(mark.noteUri, actorUri, mark.kind, ai && ai.handle);
        wakeGuardian(slug);   // een mede-guardian pakte iets op: het paneel hoort het meteen
        console.log('[AP] help', mark.kind, actorUri, '→', mark.noteUri);
      }
    }
    if (actorUri && !isLocalActor && o.id) {
      const slugs = localMentionSlugs(o.tag, base);
      if (slugs.length) {
        const ai = actorInfo(await resolveActor(actorUri), actorUri);
        const html = HtmlSanitizerService.sanitize(o.content || '');
        // FEP-633c 5.2.1: a ward's call for help rides a direct mention; the
        // flag is stored so the Guardian PWA's message centre can list it.
        const help = Guardianship.isHelpRequest(o);
        const wave = Guardianship.isWave(o);
        const hasG = Guardianship.objectHasGuardians(o);   // §2.2 hint, register-only
        // FEP-633c 3.6.1: a guardian declares itself away to its ward, on the
        // same direct note the mention below stores (so the kid also reads it
        // as an ordinary message). Recorded only from an actual guardian of
        // the addressed ward, and only with an end: an absence without an end
        // is logged and dropped, never guessed.
        if (Guardianship.availability.isAway(o)) {
          const until = Guardianship.availability.parseEndTime(o.endTime);
          for (const slug of slugs) {
            const isG = (() => { try { return Guardianship.listGuardians(slug).some((g) => g.other_uri === actorUri); } catch { return false; } })();
            if (!isG) continue;
            if (!until || until <= Date.now()) { console.warn('[AP] away without a (future) end ignored (3.6.1):', actorUri, '→', slug); continue; }
            Guardianship.availability.declareAway(slug, actorUri, until);
            console.log('[AP] guardian declared away (3.6.1):', actorUri, '→', slug, 'until', new Date(until).toISOString());
          }
        }
        // Een kind dat zelf om een poort vraagt (shaer-8ru). Zelfde weg als de
        // afwezigheidsmelding: een gewone directe note met een shaer:-markering,
        // per genoemde ontvanger afgehandeld.
        //
        // ALLEEN VAN EEN EIGEN WARD. Een verzoek van een vreemde is geen vraag
        // maar een onbekende die iets over jouw instellingen wil zeggen -- dat
        // hoort in geen enkele lijst te belanden waar een guardian op afgaat.
        {
          const req = Guardianship.gatereq.parseRequest(o);
          if (req) {
            for (const slug of slugs) {
              const mijn = (() => { try { return Guardianship.listWards(slug).some((w) => w.other_uri === actorUri); } catch { return false; } })();
              if (!mijn) { console.warn('[AP] gate request from someone who is not our ward, ignored:', actorUri, '→', slug); continue; }
              Guardianship.gatereq.record(slug, actorUri, req.feature, o.id);
              wakeGuardian(slug);   // het kind vroeg om een poort
              console.log('[AP] gate request', req.feature, actorUri, '→', slug);
            }
          }
        }
        for (const slug of slugs) {
          try {
            const r = db.prepare(`INSERT OR IGNORE INTO ap_mentions (slug, object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, actor_url, content, published, help_request, wave, has_guardians, emoji_json, actor_emoji_json, media_json, created_at)
                                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`)
              .run(slug, o.id, safeUrl(o.url) || null, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.published || null, help ? 1 : 0, wave ? 1 : 0, hasG ? 1 : 0,
                extractEmojiTags(o.tag), emojiJsonOf(ai.emojis), mediaFromNote(o));
            if (r.changes) {
              // The quote / link-preview card resolves out of band (a remote
              // fetch), exactly as it does for a timeline post, so the inbox
              // answer is never blocked on it.
              resolveCard(o).then((c) => {
                if (!c) return;
                const col = c.column === 'quote_json' ? 'quote_json' : 'embed_json';   // never a value from the wire
                try { db.prepare(`UPDATE ap_mentions SET ${col} = ? WHERE slug = ? AND object_uri = ?`).run(c.json, slug, o.id); } catch { /* ignore */ }
              }).catch(() => { /* best-effort */ });
              console.log('[AP] mention', actorUri, '→', slug, help ? '(help request)' : '');
              const vis = noteVisibility(o);
              const priv = vis === 'direct' || vis === 'followers';
              const L = pushLang(slug);
              const who = ai.name || ai.handle || i18nT(L, 'notif.someone');
              // Same privacy rule as replies: private mentions push without content.
              // A help request pushes as its own alert type, aimed at the
              // Guardian PWA's message centre.
              if (help) pushEvent(slug, { type: 'help', title: i18nT(L, 'push.n_help_t'), body: i18nT(L, 'push.n_help_b', { who }), url: '/guardian' });
              else if (priv) pushEvent(slug, { type: 'dm', title: i18nT(L, 'push.n_dm_t'), body: i18nT(L, 'push.n_dm_b', { who }), url: `${pushPrefix(slug)}/messages` });
              else pushEvent(slug, { type: 'reply', title: i18nT(L, 'push.n_mention_t'), body: `${who}: ${HtmlSanitizerService.toPlainText(html).slice(0, 90)}`, url: `${pushPrefix(slug)}/messages` });
            }
          } catch { /* ignore */ }
        }
      }
    }
    return 202;
  }
  // A remote post we cached was edited upstream → refresh our cached copy. This is the
  // push-based edit-sync that keeps the Cirkel/timeline fresh without polling (selfHeal
  // does it on a version bump; this does it live). Scope to the SIGNING actor so B can't
  // edit A's note (the signature gate guarantees claimedActor == the verified signer).
  if (type === 'Update' && act.object && (act.object.type === 'Note' || act.object.type === 'Article' || act.object.type === 'Question')) {
    const o = act.object;
    if (o.id && claimedActor) {
      const html = HtmlSanitizerService.sanitize(o.content || '');
      const media = mediaFromNote(o);
      try {
        // Refresh url too (COALESCE keeps the old one if the Update omits it): a remote slug
        // rename keeps the same AP id but changes the human url, so without this the cached
        // post would keep linking to the old, now-dead URL.
        const r = db.prepare('UPDATE ap_timeline SET content = ?, media_json = ?, nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE id = ? AND author_uri = ?')
          .run(html, media, o.sensitive ? 1 : 0, contentWarning(o), o.url || null, o.id, claimedActor);
        if (r.changes) console.log('[AP] timeline update', claimedActor, '→', o.id);
        // A poll's Update carries the fresh vote counts / closed state. Refresh per-row so each
        // site keeps its own `voted` state while the counts/closed update to the new totals.
        const poll = parsePoll(o);
        if (poll) {
          const rows = db.prepare('SELECT rowid AS rid, poll_json FROM ap_timeline WHERE id = ? AND author_uri = ?').all(o.id, claimedActor);
          const upd = db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE rowid = ?');
          for (const rw of rows) {
            let voted = null; try { voted = rw.poll_json ? (JSON.parse(rw.poll_json).voted || null) : null; } catch { /* ignore */ }
            upd.run(JSON.stringify({ ...poll, voted }), rw.rid);
          }
        }
      } catch { /* ignore */ }
      // If this note is a cached fediverse reply on one of our posts, refresh its text too.
      try { db.prepare('UPDATE ap_interactions SET content = ? WHERE object_uri = ? AND actor_uri = ?').run(html, o.id, claimedActor); } catch { /* ignore */ }
    }
    return 202;
  }
  if (type === 'Like' || type === 'Announce') {
    const tgt = act.object;
    const objUrl = typeof tgt === 'string' ? tgt : (tgt && tgt.id);
    const pid = postIdFromNoteUrl(objUrl, base);
    if (pid && actorUri && !isLocalActor && localPostExists(pid)) {
      // A boost/like of a non-public post is dropped, not stored: nobody
      // outside the audience should even hold it (shaer-tqc hardening).
      const vp = db.prepare('SELECT fan_only, ap_visibility FROM posts WHERE id = ?').get(pid);
      if (vp && (vp.fan_only || vp.ap_visibility === 'direct' || vp.ap_visibility === 'friends')) {
        console.log('[AP] dropped', type, 'on non-public post', pid);
        return;
      }
      const ai = actorInfo(await resolveActor(actorUri), actorUri);
      iStmts().ins.run(type.toLowerCase(), pid, '', actorUri, ai.name, ai.handle, ai.url, ai.icon, null, null, null, noteVisibility(act), null, emojiJsonOf(ai.emojis));
      console.log('[AP]', type === 'Like' ? 'like' : 'boost', actorUri, '→', pid);
      {
        const ctx = pushPostCtx(pid);
        if (ctx) {
          const L = pushLang(ctx.site);
          const who = ai.name || ai.handle || i18nT(L, 'notif.someone');
          if (type === 'Like') pushEvent(ctx.site, { type: 'like', title: i18nT(L, 'push.n_like_t'), body: i18nT(L, 'push.n_like_b', { who, title: ctx.title }), url: ctx.url });
          else pushEvent(ctx.site, { type: 'boost', title: i18nT(L, 'push.n_boost_t'), body: i18nT(L, 'push.n_boost_b', { who, title: ctx.title }), url: ctx.url });
        }
      }
    } else if (type === 'Announce' && objUrl && actorUri && !isLocalActor) {
      // A boost FROM an account we follow, of a REMOTE post → show it in the News feed.
      // We only STORE it for display; we NEVER auto-Announce it onward (anti-feedback-loop:
      // re-announcing an incoming Announce would cascade boosts across the network).
      let subs = []; try { subs = db.prepare('SELECT slug FROM ap_following WHERE actor_uri = ?').all(actorUri); } catch { /* table may not exist */ }
      if (subs.length) {
        const bn = await fetchNoteAP(objUrl);
        if (bn && bn !== 404 && (bn.type === 'Note' || bn.type === 'Article') && bn.id) {
          const origUri = actorUriOf(bn.attributedTo);
          // Block completeness: even if you follow the booster, drop a boost whose ORIGINAL
          // author is blocked — otherwise a block is bypassed via someone else's boost.
          if (origUri && isBlockedAny(origUri)) { console.log('[AP] timeline boost dropped (blocked origin)', origUri, 'via', actorUri); return 202; }
          const oai = actorInfo(await resolveActor(origUri), origUri);
          const html = HtmlSanitizerService.sanitize(bn.content || '');
          const media = mediaFromNote(bn);
          const booster = actorInfo(await resolveActor(actorUri), actorUri);
          for (const s of subs) {
            // published = now → the boost shows as fresh activity at the top (Mastodon shows
            // reblogs at reblog-time, not the original's date). INSERT OR IGNORE: if we already
            // have the note (e.g. we also follow the author), keep it and DON'T relabel it.
            let inserted = false;
            try { const r = tlStmts().ins.run(bn.id, s.slug, origUri || '', oai.name, oai.handle, oai.icon, oai.url, html, bn.url || null, new Date().toISOString(), media, bn.sensitive ? 1 : 0, contentWarning(bn)); inserted = r.changes > 0; } catch { /* ignore */ }
            if (inserted) { try { db.prepare('UPDATE ap_timeline SET reblog_name = ?, reblog_handle = ?, reblog_icon = ?, reblog_emoji_json = ? WHERE slug = ? AND id = ?').run(booster.name, booster.handle, booster.icon, (booster.emojis && Object.keys(booster.emojis).length) ? JSON.stringify(booster.emojis) : null, s.slug, bn.id); } catch { /* ignore */ } }
            storeAuthorEmoji(bn.id, s.slug, oai);   // custom-emoji display name for the byline
            // A boost carries the same renderable tags as a Create: capture the
            // note's content emojis (FEP-9098) and object links / quote (FEP-e232/
            // 044f) so boosted posts render like any other, not as raw shortcodes.
            { const ej = extractEmojiTags(bn.tag); if (ej) { try { db.prepare('UPDATE ap_timeline SET emoji_json = ? WHERE id = ? AND slug = ?').run(ej, bn.id, s.slug); } catch { /* ignore */ } } }
            { const lj = extractLinkJson(bn); if (lj) { try { db.prepare('UPDATE ap_timeline SET link_json = ? WHERE id = ? AND slug = ?').run(lj, bn.id, s.slug); } catch { /* ignore */ } } }
          }
          // FEP-044f: resolve the embedded quote card for a boosted post too
          // (out of band, best-effort, so it does not block the inbox response).
          if (quoteHrefOf(bn)) {
            const slugs = subs.map((s) => s.slug);
            resolveQuote(bn).then((qj) => {
              if (!qj) return;
              for (const sl of slugs) { try { db.prepare('UPDATE ap_timeline SET quote_json = ? WHERE id = ? AND slug = ?').run(qj, bn.id, sl); } catch { /* ignore */ } }
            }).catch(() => { /* best-effort */ });
          }
          console.log('[AP] timeline boost +', actorUri, 'x' + subs.length);
        }
      }
    }
    return 202;
  }
  if (type === 'Delete') {
    // A remote note was deleted upstream → drop it from replies AND the timeline.
    // Scope to the SIGNING actor so actor B can't delete actor A's content (the
    // signature gate guarantees claimedActor == the verified signer here).
    const oid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    if (oid && claimedActor) {
      try { db.prepare('DELETE FROM ap_interactions WHERE object_uri = ? AND actor_uri = ?').run(oid, claimedActor); } catch { /* ignore */ }
      try { db.prepare('DELETE FROM ap_timeline WHERE id = ? AND author_uri = ?').run(oid, claimedActor); } catch { /* ignore */ }
      // Also clear a boost/like YOU made of this now-deleted remote post (the interact-page
      // ap_my_reactions state), so it can't stay stuck as "boosted" on a post that's gone.
      // Guard: only when the deleter owns the note's domain (B mustn't clear your reactions
      // to A's posts).
      try {
        let sameHost = false;
        try { sameHost = new URL(oid).host === new URL(claimedActor).host; } catch { sameHost = false; }
        if (sameHost) db.prepare('DELETE FROM ap_my_reactions WHERE target_uri = ?').run(oid);
      } catch { /* ignore */ }
    }
    return 202;
  }
  // Accept/Reject of a Follow WE sent (client side).
  if (type === 'Accept' && act.object) {
    const fid = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
    let raak = 0;
    if (fid) { try { raak = fwStmts().acc.run(fid).changes; } catch { /* ignore */ } }
    // TERUGVAL, en die is nodig gebleken tegen Funkwhale. Een Accept hoort de
    // Follow terug te geven die hij beantwoordt, maar Funkwhale verzint er een
    // EIGEN id voor, in ONZE namespace:
    //
    //   wij stuurden   .../ap/users/dev#follow-1786161977286-bb2de32f
    //   Funkwhale zegt .../ap/users/dev#follows/19fd8b00-8f66-...
    //
    // Matchen op follow_id raakt dan niets, en de volgrelatie bleef eeuwig op
    // 'pending' staan terwijl de logregel 'accepted' riep -- een stille no-op
    // die pas opviel toen er nooit iets binnenkwam.
    //
    // Het paar dat we WEL zeker weten is (deze site, deze actor): de Accept is
    // handtekening-geverifieerd, en actorUri is de ondertekenaar. Alleen een
    // rij die nog op pending staat wordt geraakt, dus dit kan niets anders
    // openzetten dan een follow die wij zelf hebben verstuurd.
    //
    // En de slug mag NIET van slugParam afhangen: Funkwhale bezorgt op de
    // GEDEELDE inbox, en dan is die leeg. Wie wij zijn staat in de ingesloten
    // Follow -- die hebben wij immers zelf verstuurd, dus `object.actor` is
    // onze eigen actor-URI.
    let mij = slugParam;
    if (!mij && act.object && typeof act.object === 'object') mij = slugFromActorUrl(act.object.actor);
    if (!raak && mij && actorUri) {
      try { raak = fwStmts().accByActor.run(mij, actorUri).changes; } catch { /* ignore */ }
    }
    // Eerlijk loggen: zonder treffer is er niets geaccepteerd, en dat hoort te
    // zien te zijn in plaats van als succes voorbij te komen.
    console.log('[AP] follow', raak ? 'accepted' : 'accept UNMATCHED', actorUri, fid ? '(' + fid + ')' : '');
    // The moment a friendship exists is the moment the history comes along
    // (Robins besluit, 30-7): delivery cannot reach into the past, so the
    // fresh follower pulls the outbox, signed, and the other side now serves
    // the friends-only posts too.
    if (slugParam && actorUri) backfillFromOutbox(slugParam, actorUri).catch(() => { /* best-effort */ });
    return 202;
  }
  if (type === 'Reject' && act.object) {
    const who = actorUri;
    if (who && slugParam) { try { fwStmts().del.run(slugParam, who); } catch { /* ignore */ } }
    return 202;
  }

  // Zeg ook WAT er viel. Een kale "Create (ignored)" verbergt het verschil
  // tussen een soort die we bewust overslaan en een die we niet kennen -- en
  // dat verschil was precies de vraag bij Funkwhale, dat Create(Audio) stuurt
  // waar deze inbox alleen Note, Article en Question aanneemt.
  const objType = act.object && typeof act.object === 'object' ? act.object.type : (typeof act.object === 'string' ? '<uri>' : null);
  console.log('[AP] inbox', type || 'unknown', objType ? '(' + objType + ')' : '', '→', slugParam || 'shared',
    'from', ip, 'by', claimedActor || '?', '(ignored)');
  return 202;
}

// ── Op slot na een verhuizing (FEP-7628) ──────────────────────────
//
// Een verhuisd account serveert `movedTo` en is daarmee dood verklaard. Toch kon
// je er gewoon op posten, volgen, liken en reageren, en dat federeerde vrolijk
// de wereld in. Drie dingen gaan daar mis:
//
//   - Nieuwe posts krijgen een object-URI op een adres dat je hebt opgezegd. Die
//     URI's overleven het domein niet, en de reacties erop ook niet.
//   - Je volgers zijn al verhuisd, dus je post in het niets terwijl het lijkt of
//     je post.
//   - Een server die je movedTo ziet EN tegelijk verse activiteit van dat adres
//     krijgt, krijgt tegenstrijdige signalen over de verhuizing.
//
// Daarom staat de poort op de UITGAANDE kant en niet op de knoppen: een
// C2S-client (Shaer) praat rechtstreeks met deze functies en zou anders zo langs
// een verborgen knop lopen. De UI volgt de poort, niet andersom.
//
// WAT DICHT GAAT: posten, reageren, volgen, liken, boosten, stemmen, en een
// tweede verhuizing.
// WAT OPEN BLIJFT: alles wat de wegwijzer draagt (de actor, webfinger, je
// bestaande posts, de outbox), alles inkomend (reacties op oude posts blijven
// binnenkomen en leesbaar), je eigen beheer (archief exporteren, volglijst
// downloaden), en ontvolgen -- opruimen mag altijd.
// Rapporteren blijft OOK open: dat is een veiligheidsklep, geen inhoud maken.
//
// OMKEERBAAR: `moved_to` leegmaken heft het slot op. Een verhuizing kan mislukken
// en dan moet je terug kunnen.
export function movedLock(site) {
  const to = site && site.moved_to && /^https?:\/\//i.test(String(site.moved_to))
    ? String(site.moved_to) : null;
  return to ? { locked: true, movedTo: to } : { locked: false, movedTo: null };
}

/** Weigering in de vorm die de aanroepers al kennen: een object met `error`. */
function movedRefusal(site, wat) {
  const l = movedLock(site);
  if (!l.locked) return null;
  console.warn('[AP] geweigerd, dit account is verhuisd:', wat, '→', l.movedTo);
  return { error: 'moved', movedTo: l.movedTo };
}

// Deliver a new post as Create(Note) to all followers' inboxes (fire-and-forget).
// Needs PUBLIC_BASE_URL (absolute URLs); no-op without followers or base.
export async function deliverCreate(site, post) {
  if (movedLock(site).locked) { console.warn('[AP] Create niet bezorgd, account verhuisd:', site && site.slug); return; }
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  // Resolve inline @user@host mentions → link them in the note + collect their inboxes, so a
  // mentioned person is notified even if they don't follow us (Mastodon-standard mention).
  const mres = await resolveMentionsInText(base, post.content || '');
  let post2 = mres.inboxes.length ? { ...post, content: mres.html } : post;
  // FEP-044f: does this post quote a fediverse object? Resolve it once, here,
  // and remember it on the post, so buildNote (sync, also used by the outbox)
  // never has to fetch. The quoted author's inbox joins the delivery set: that
  // IS the notification.
  const quoteInboxes = [];
  // EERST BAKKEN, dan pas linken zoeken (shaer-k3f, gevonden op het toestel):
  // firstExternalUrl leest <a href>-ankers, en de web-editor bakt die er bij
  // het opslaan al in -- maar een post uit de APP is platte tekst waarin de
  // URL nog geen anker is. Zonder deze bak zag het C2S-pad dus nooit een link
  // en kreeg een app-post nooit een kaart, terwijl de preview hem net wel
  // beloofd had.
  const gebakken = bakePostContent(post2.content || '');
  if (post2.quote_uri === undefined || post2.quote_uri === null) {
    const q = await resolveOwnQuote(gebakken);
    if (q) {
      try { db.prepare('UPDATE posts SET quote_uri = ?, quote_actor = ? WHERE id = ?').run(q.uri, q.actor || null, post.id); } catch { /* ignore */ }
      post2 = { ...post2, quote_uri: q.uri, quote_actor: q.actor || null };
    }
  }
  // De kaart op de eigen post (shaer-k3f), langs dezelfde pijplijn als een
  // binnenkomende: een fediverse-quote wordt een quote-snapshot, anders
  // probeert de link een externe kaart. VOOR de vroege return hieronder, want
  // ook een post zonder volgers hoort zijn kaart te krijgen -- de app leest
  // hem uit de outbox, niet uit een bezorging. Best-effort en eenmalig: wat
  // hier niet lukt blijft een kale link, precies wat het was.
  if (!post2.quote_json && !post2.embed_json) {
    try {
      if (post2.quote_uri) {
        const qj = await resolveQuoteByUri(post2.quote_uri);
        if (qj) { db.prepare('UPDATE posts SET quote_json = ? WHERE id = ?').run(qj, post.id); post2 = { ...post2, quote_json: qj }; }
      } else {
        const ej = await resolveExternalEmbed(gebakken);
        if (ej) { db.prepare('UPDATE posts SET embed_json = ? WHERE id = ?').run(ej, post.id); post2 = { ...post2, embed_json: ej }; }
      }
    } catch { /* een kaart is nooit een blokkade voor de post zelf */ }
  }
  if (post2.quote_actor) {
    const a = await fetchActor(post2.quote_actor).catch(() => null);
    const inbox = a && ((a.endpoints && a.endpoints.sharedInbox) || a.inbox);
    if (inbox) quoteInboxes.push(inbox);
  }
  const followers = fStmts().list.all(site.slug);
  const inboxes = [...new Set([...followers.map((f) => f.shared_inbox || f.inbox), ...mres.inboxes, ...quoteInboxes].filter(Boolean))];
  if (!inboxes.length) return; // no followers, no one mentioned, no one quoted
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${actorId(base, site.slug)}#main-key`;
  const create = buildCreate(base, site, post2);
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, create, keyId, keys.private_pem);
}

// On a new Follow, send that follower our most recent posts as Create so their
// timeline shows our history (Mastodon does not backfill on follow). Oldest-first
// so they sort into the follower's timeline at their original dates.
async function backfillNewFollower(base, slug, inbox) {
  if (!base || !slug || !inbox) return;
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
  if (!site) return;
  const recent = db.prepare(
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, c2s_attachments, published_at, created_at
     FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20`
  ).all(site.id).reverse();
  if (!recent.length) return;
  const keys = getOrCreateKeys(slug);
  const keyId = `${actorId(base, slug)}#main-key`;
  for (const p of recent) {
    try { await deliver(inbox, buildCreate(base, site, p), keyId, keys.private_pem); } catch { /* best-effort */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log('[AP] backfilled', recent.length, 'posts to new follower of', slug);
}

// Tell followers a post is gone (Delete + Tombstone) so it's removed from their feeds.
export async function deliverDelete(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !post || !post.id) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const nid = noteId(base, post.id);
  const del = {
    '@context': AP_CONTEXT,
    id: `${nid}#delete-${Date.now()}-${rid()}`,
    type: 'Delete',
    actor: me,
    to: [PUBLIC],
    object: { id: nid, type: 'Tombstone' },
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, del, `${me}#main-key`, keys.private_pem);
}

// Tell followers an already-published post changed (Update + edited Note) so
// Mastodon refreshes the cached copy (e.g. after fixing content).
export async function deliverUpdate(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !post || !post.id) return;
  const mres = await resolveMentionsInText(base, post.content || ''); // link mentions + collect inboxes
  const post2 = mres.inboxes.length ? { ...post, content: mres.html } : post;
  const followers = fStmts().list.all(site.slug);
  const inboxes = [...new Set([...followers.map((f) => f.shared_inbox || f.inbox), ...mres.inboxes].filter(Boolean))];
  if (!inboxes.length) return;
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const note = buildNote(base, site, post2);
  note.updated = new Date().toISOString();
  const update = {
    '@context': AP_CONTEXT,
    id: `${noteId(base, post.id)}#update-${Date.now()}-${rid()}`,
    type: 'Update', actor: me, to: [PUBLIC], cc: note.cc,
    object: note,
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, update, `${me}#main-key`, keys.private_pem);
}

// Tell followers the ACTOR changed (Update + Person) so Mastodon re-processes the
// account AND re-fetches the featured (pinned) collection — there is no standard
// "featured changed" activity, so this is how a pin/unpin propagates promptly.
export async function deliverActorUpdate(site) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const update = {
    '@context': AP_CONTEXT,
    id: `${me}#update-${Date.now()}-${rid()}`,
    type: 'Update', actor: me, to: [PUBLIC], cc: [`${me}/followers`],
    object: buildActor(base, site),
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, update, `${me}#main-key`, keys.private_pem);
}

// Reliably set the pinned order on followers' instances via Add/Remove activities
// (how Mastodon itself federates pins) — pushed to the inbox + processed immediately,
// unlike the featured COLLECTION which Mastodon caches with sticky StatusPins.
// Mastodon's Add skips an already-pinned status, so we REMOVE every pin first, wait,
// then ADD in rank-DESCENDING order (rank 1 added LAST → newest StatusPin → shown first,
// because Mastodon displays pins newest-first). `alsoRemove` = ids to unpin too.
// Serialize pin-resyncs per site: two concurrent /save calls would otherwise interleave
// their Remove -> wait -> Add sequences and scramble the StatusPin order on Mastodon. A
// resync already in flight for a site coalesces later requests into ONE rerun after it
// finishes (accumulating their extra unpins), so rapid saves don't pile up N full resyncs.
const _pinResync = new Map(); // slug -> { promise, pending, pendingRemove:Set, site }
export function resyncFeaturedPins(site, alsoRemove = []) {
  if (!site || !site.slug) return Promise.resolve();
  const slug = site.slug;
  const running = _pinResync.get(slug);
  if (running) {
    running.pending = true;
    running.site = site; // use the latest site object on the rerun
    for (const id of alsoRemove) running.pendingRemove.add(id);
    return running.promise;
  }
  const state = { promise: null, pending: false, pendingRemove: new Set(), site };
  state.promise = (async () => {
    let extra = alsoRemove;
    for (;;) {
      try { await doResyncFeaturedPins(state.site, extra); }
      catch (e) { console.warn('[AP] pin resync failed:', e.message); }
      if (!state.pending) break;
      state.pending = false;
      extra = [...state.pendingRemove];
      state.pendingRemove = new Set();
    }
    _pinResync.delete(slug);
  })();
  _pinResync.set(slug, state);
  return state.promise;
}

// The actual resync work — do NOT call directly; go through resyncFeaturedPins() above so
// it stays serialized per site.
async function doResyncFeaturedPins(site, alsoRemove = []) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const keyId = `${me}#main-key`;
  const featured = `${me}/featured`;
  const note = (id) => noteId(base, id);
  const pinned = db.prepare(
    `SELECT id FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
       AND pinned IS NOT NULL AND pinned > 0
     ORDER BY pinned DESC, COALESCE(published_at, created_at) ASC LIMIT 20`
  ).all(site.id);
  const removeIds = [...new Set([...pinned.map((p) => p.id), ...alsoRemove])];
  // 1. Remove every current pin so Mastodon can recreate them in order.
  for (const id of removeIds) {
    const rm = { '@context': AP_CONTEXT, id: `${me}#rm-${id}-${Date.now()}-${rid()}`, type: 'Remove', actor: me, object: note(id), target: featured, to: [PUBLIC] };
    for (const inbox of inboxes) deliver(inbox, rm, keyId, keys.private_pem).catch(() => { /* best-effort */ });
  }
  if (!pinned.length) { console.log('[AP] unpinned all featured for', site.slug); return; }
  await new Promise((r) => setTimeout(r, 5000)); // let the Removes land first
  // 2. Add in rank-DESC order, gaps so each StatusPin gets an increasing created_at.
  for (const p of pinned) {
    const add = { '@context': AP_CONTEXT, id: `${me}#add-${p.id}-${Date.now()}-${rid()}`, type: 'Add', actor: me, object: note(p.id), target: featured, to: [PUBLIC], cc: [`${me}/followers`] };
    for (const inbox of inboxes) deliver(inbox, add, keyId, keys.private_pem).catch(() => { /* best-effort */ });
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('[AP] resynced', pinned.length, 'featured pins for', site.slug);
}

// ── outbound replies (Klonkt → fediverse) ─────────────────────────
const escHtml = (s) => String(s || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const toISO = (v) => { if (!v) return new Date().toISOString(); const s = String(v); const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z'); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };

// Build one of OUR outbound reply Notes from an ap_outbox row.
// Turn #hashtags in reply text into Mastodon-style hashtag links (clickable + federated).
function linkHashtags(base, html) {
  // Prefix: start / whitespace / '>' / opening bracket — "(#tag" is a tag too. NO quote
  // chars in this class: a quote precedes attribute values (alt="#…"), which must not match.
  return String(html || '').replace(/(^|[\s>([{])#([\p{L}\p{M}\p{N}_]+)/gu, (m, pre, tag) =>
    `${pre}<a href="${base}/tag/${encodeURIComponent(tag.toLowerCase())}" class="mention hashtag" rel="tag">#${tag}</a>`);
}
// Auto-link bare http(s) URLs in already-safe HTML (federated copies). Splits on existing
// <a>…</a> so a linked URL is never wrapped twice; requires start/whitespace/'>' before the
// URL so attribute values (src="https://…") never match. Trailing sentence punctuation stays
// outside the link (Mastodon-style).
function linkUrls(html) {
  const parts = String(html || '').split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi);
  for (let i = 0; i < parts.length; i++) {
    if (/^<a\b/i.test(parts[i])) continue; // already a link → leave as-is
    parts[i] = parts[i].replace(/(^|[\s>([{])(https?:\/\/[^\s<]+?)([.,;:!?)\]»]*)(?=$|[\s<])/g,
      (m, pre, url, trail) => `${pre}<a href="${url.replace(/"/g, '%22')}" rel="nofollow noopener" target="_blank">${url}</a>${trail}`);
  }
  return parts.join('');
}
// Linkify inline #hashtags and bare URLs in BODY html for on-site DISPLAY, using the
// EXACT same rules as the federated copy (linkHashtags/linkUrls), so the website and the
// Mastodon copy agree instead of the website showing raw text. Idempotent: existing
// <a>…</a> (editor links, embeds, shortcode buttons) are split out and left untouched, so
// nothing is double-wrapped. Pass base='' → root-relative /tag/<slug> links.
export function linkifyBody(base, html) {
  const withTags = String(html || '')
    .split(/(<a\b[^>]*>[\s\S]*?<\/a>)/gi)
    .map((seg) => (/^<a\b/i.test(seg) ? seg : linkHashtags(base, seg)))
    .join('');
  return linkUrls(withTags);
}

// Bake a post's raw source into its display HTML (the ActivityPub `source` model): done ONCE
// at save and cached in posts.content_rendered, so page views serve it statically instead of
// re-linkifying every render. Step 1 = #hashtags + bare URLs (cheap, no network). Step 2 will
// resolve @mentions here too (webfinger once at save instead of per page view).
export function bakePostContent(source) {
  return linkifyBody('', source || '');
}

// Step 2: the full bake, incl. @mention links. Resolves @user@host via webfinger ONCE (the
// same resolver the federated copy uses) and bakes the profile links into content_rendered,
// so page views never do a per-view lookup. Unresolvable handles stay plain text; on any
// failure it degrades to the sync #hashtag/URL bake. Async (webfinger) → callers run it off
// the save response so the request never blocks on a slow/dead remote server.
export async function bakePostContentWithMentions(source) {
  const withHashUrls = bakePostContent(source);
  try { const m = await resolveMentionsInText('', withHashUrls); return m.html; }
  catch { return withHashUrls; }
}

// Extract the AP Hashtag tag objects from already-linked reply content.

// Normalise a post's tags field (array, JSON-string, or comma-string) to an array.
// normalizeTags en tagParts staan sinds shaer-38y in ap-core: music/ heeft ze
// ook nodig en mag hier niet uit importeren.
// A tag → { label, slug }. Multi-word tags become CamelCase (#LiveMusic) for the display
// name (Mastodon hashtags can't contain spaces; CamelCase is the accessibility norm); the
// slug/href stays lowercase ("livemusic").
// Merge a post's tags field + the #hashtags linked inline in its body into one deduped
// Hashtag tag list (with hrefs to our /tag page).
// hashtagTags en buildHashtagList staan sinds shaer-38y in ap-core: music/
// heeft dezelfde lijst nodig en mag hier niet uit importeren.

// Extract Mention tag objects from already-linked content (class="u-url mention").
function mentionTags(content) {
  const tags = [], seen = new Set();
  // The link href is the human profile URL; the actor URI (for the Mention tag) is in data-actor.
  const re = /<a href="[^"]*" class="u-url mention" data-actor="([^"]+)">@([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(content || ''))) {
    const href = m[1];
    if (seen.has(href)) continue; seen.add(href);
    tags.push({ type: 'Mention', href, name: '@' + m[2] });
  }
  return tags;
}
// Resolve inline @user@domain mentions in reply/post text → link them (href = actor URI)
// and collect the mentioned actors' inboxes so they get notified. Best-effort per mention.
async function resolveMentionsInText(base, html) {
  const inboxes = [];
  const handles = new Set();
  // Prefix also allows opening brackets — "(@user@host + me)" is a mention too (real-world
  // miss: a bracketed mention federated as plain text and its target was never notified).
  const re = /(^|[\s>([{])@([\p{L}\p{M}\p{N}_.-]+@[\p{L}\p{M}\p{N}.-]+)/gu;
  let m;
  while ((m = re.exec(html || ''))) handles.add(m[2]);
  let out = String(html || '');
  for (const h of handles) {
    let actorUri = null;
    try { actorUri = await webfingerResolve('@' + h); } catch { actorUri = null; }
    if (!actorUri) continue;
    const actor = await fetchActor(actorUri).catch(() => null);
    const inbox = actor && ((actor.endpoints && actor.endpoints.sharedInbox) || actor.inbox);
    if (inbox) inboxes.push(inbox);
    const profileUrl = actorInfo(actor, actorUri).url || actorUri; // human profile page → the link href
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp('(^|[\\s>([{])@' + esc + '(?![\\p{L}\\p{M}\\p{N}_.-])', 'gu'),
      (full, pre) => `${pre}<a href="${profileUrl}" class="u-url mention" data-actor="${actorUri}">@${h}</a>`);
  }
  return { html: out, inboxes };
}

export function buildReplyNote(base, site, row) {
  // Thin delegate: replies are built by buildNote (the single Note entry point) in reply mode.
  return buildNote(base, site, row, { isReply: true });
}

// The account's own outbound notes (replies and direct messages) as AS2
// Notes, newest first. The C2S inbox read serves these alongside the
// timeline: without them your own reply existed everywhere EXCEPT in your
// own app (Robins melding, 30-7: "replyen werkt nog niet"; het antwoord
// stond op de server maar de app kreeg het nooit terug, dus je probeerde
// het opnieuw en liep in de duplicate-guard).
export function getSentNotes(base, site, limit = 60) {
  return db.prepare('SELECT * FROM ap_outbox WHERE site_slug = ? ORDER BY created_at DESC LIMIT ?')
    .all(site.slug, limit)
    .map((row) => buildReplyNote(base, site, row));
}

// Resolve one of our outbound reply Notes by id (for /ap/notes/:id fallback).
export function getOutboxNote(base, id) {
  const row = iStmts().getO.get(id);
  if (!row) return null;
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(row.site_slug);
  if (!site) return null;
  return buildReplyNote(base, site, row);
}

// ── ActivityPub Client-to-Server: ingest an activity POSTed to the outbox ──
// The C2S counterpart of handleInbox: a native/web client (Shaer) posts an
// activity here and we translate it onto the SAME delivery machinery the web UI
// uses (deliverReply / sendInteraction / followActor / deliverCreate). Returns
// { status, id?, url?, error? }. Auth + site-ownership are checked by the route.
const c2sIdOf = (x) => (typeof x === 'string' ? x : (x && (x.id || x.href))) || null;

export async function ingestOutboxActivity(site, user, activity) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !activity || typeof activity !== 'object') return { status: 400, error: 'invalid_activity' };

  // AP §6: a client MAY POST a bare object; the server wraps it in a Create.
  let type = activity.type;
  let object = activity.object;
  if (type === 'Note' || type === 'Article') { object = activity; type = 'Create'; }
  if (Array.isArray(type)) type = type.find((t) => typeof t === 'string');

  // FEP-633c: the adoption handshake (Offer/Accept/Reject on a guardianship
  // Relationship) belongs to the guardianship module; anything else falls
  // through to the switch below.
  if (type === 'Offer' || type === 'Accept' || type === 'Reject') {
    const g = await Guardianship.handleGuardianshipOutbox(site, activity).catch(() => null);
    if (g) return g;
  }
  // Een gate-voorstel uit de app (5.6, shaer-8ru): een Offer van een
  // shaer:GatedSetting, de vorm die 5.6 al beschrijft.
  //
  // HIER, EN GEEN `case` IN DE SWITCH. Dat was hij eerst, en die claimde ELKE
  // Offer: wat geen gate-voorstel was kreeg 400 unsupported_offer -- ook de
  // adoptie-handshake, en straks elke Offer-vorm die we nog toevoegen. Barts
  // honderd aanbiedingen liepen er meteen op stuk. Alleen claimen wat je
  // herkent, en de rest laten doorlopen.
  if (type === 'Offer') {
    const gs = Guardianship.gated.parseGatedSetting(activity.object);
    if (gs) {
      const uit = proposeGate(site, gs.ward, gs.feature, gs.value);
      return uit.status === 200 ? { ...uit, status: 201, id: uit.offerId } : uit;
    }
  }

  try {
    switch (type) {
      case 'Create': {
        if (!object || typeof object !== 'object') return { status: 400, error: 'missing_object' };
        // Innamepoorten (shaer-ahy.1, 8-8): wat de ward niet mag versturen
        // wordt HIER geweigerd, niet in de app verstopt -- een knop die de
        // client alleen verbergt is geen poort. De reddingsboei gaat ALTIJD
        // voor: een hulpvraag aan de guardians mag door elke dichte deur heen,
        // anders sluit een messages-poort precies het kanaal af dat het kind
        // veilig houdt.
        {
          const isWard = (() => { try { return Guardianship.listGuardians(site.slug).length > 0; } catch { return false; } })();
          const isHelp = object['shaer:helpRequest'] === true || object.helpRequest === true;
          // Een poortverzoek van het kind zelf (shaer-8ru) gaat langs de
          // messages-poort. Dat lijkt een gat en is het niet: het verzoek draagt
          // ALLEEN de naam van de feature, geen vrije tekst, dus er ontstaat geen
          // kanaal om omheen die poort te praten. Zonder deze uitzondering kan
          // een kind met berichten dicht nergens meer om vragen -- en dan is de
          // hele weg dood op precies het moment dat hij nodig is.
          const isGateReq = !!Guardianship.gatereq.parseRequest(object);
          const direct = c2sVisibility(object) === 'direct';
          if (!isHelp && !isGateReq) {
            if (direct && !Guardianship.wardGateAllowed(site.gate_messages, isWard)) {
              return { status: 403, error: 'gated_messages' };
            }
            if (!direct && !object.inReplyTo && !Guardianship.wardGateAllowed(site.gate_compose, isWard)) {
              return { status: 403, error: 'gated_compose' };
            }
            // Meedoen aan een gesprek is ook iets (Bart, 8-8). Hier stond de
            // aanname dat een antwoord geen eigen podium is en dus onder compose
            // door mocht. Dat is teruggedraaid: antwoorden heeft een EIGEN poort,
            // los van compose in beide richtingen -- je kunt willen dat een kind
            // meepraat zonder podium, en ook andersom.
            //
            // Geldt ook voor een DIRECT antwoord, bovenop de messages-poort: een
            // privé-antwoord is allebei, en dan mag allebei hem tegenhouden.
            if (object.inReplyTo && !Guardianship.wardGateAllowed(site.gate_replies, isWard)) {
              return { status: 403, error: 'gated_replies' };
            }
          }
        }
        // Client sends `source` (plain/markdown) + `content` (HTML). deliverReply
        // re-escapes, so it needs plain text; a top-level post keeps sanitized HTML.
        const plain = (object.source && object.source.content) || HtmlSanitizerService.toPlainText(object.content || '');
        // A picture (or a recording) can be the whole message: media-only
        // notes pass here; c2sCreatePost validates the attachments themselves.
        if (!plain.trim() && !object.content && !(Array.isArray(object.attachment) && object.attachment.length)) {
          return { status: 400, error: 'empty_note' };
        }
        // Direct (private mention, shaer-tqc): NOT a post. Delivered over the
        // outbox machinery to the addressed inboxes only; shows under Messages.
        if (c2sVisibility(object) === 'direct') {
          const arr = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).filter((x) => typeof x === 'string');
          const recipients = [...new Set([...arr(object.to), ...arr(object.cc)])]
            .filter((u) => /^https?:\/\//i.test(u) && !/\/followers\/?$/.test(u) && u !== PUBLIC);
          if (!recipients.length) return { status: 400, error: 'no_recipients' };
          // AS2 attachments (e.g. the help-buoy capture, uploaded via
          // uploadMedia): normalize our own absolute /media/ URLs to relative
          // so the deliverReply-style validation applies unchanged.
          const atts = (Array.isArray(object.attachment) ? object.attachment : [])
            .map((a) => a && typeof a === 'object' ? {
              url: String(a.url || '').replace(new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ''),
              mediaType: String(a.mediaType || ''),
              name: String(a.name || '').slice(0, 120),
            } : null)
            .filter(Boolean);
          const help = object['shaer:helpRequest'] === true || object.helpRequest === true;
          // FEP-633c 3.6.1: a guardian here declaring itself away to its
          // wards. An away without a (future) end fails loudly, exactly as
          // the daemon refuses it: stored quietly it would be a nominal
          // guardian holding a seat.
          let awayUntil = null;
          if (Guardianship.availability.isAway(object)) {
            awayUntil = Guardianship.availability.parseEndTime(object.endTime);
            if (!awayUntil || awayUntil <= Date.now()) return { status: 400, error: 'away_needs_an_end' };
            // No local shortcut here: the note below reaches a ward on this
            // instance through the loopback, and its inbox handler applies the
            // absence like it does for a ward anywhere else. One path.
          }
          const gateReq = Guardianship.gatereq.parseRequest(object);
          // Een hulpvraag oppikken of afsluiten vanuit de app (5.2.1, shaer-lgo).
          // De markering IS al een gewone directe note met een shaer:-eigenschap,
          // dus hier hoeft niets nieuws bij: de app stuurt precies wat de PWA
          // stuurt, en het gaat over dezelfde bezorging naar de mede-guardians.
          //
          // We boeken hem ook LOKAAL. Zonder dat zou de guardian die de knop
          // indrukt zijn eigen markering pas zien als hij bij zichzelf
          // terugkomt -- en die weg bestaat niet.
          const mark = Guardianship.help.parseMarker(object);
          if (mark) {
            const base2 = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
            // Met de VOLLEDIGE handle. Hier stond `@${site.slug}` -- zonder host,
            // dus een derde vorm naast de kale URI van de PWA-route en de echte
            // handle die een binnengekomen markering draagt. Drie spellingen van
            // dezelfde naam, en "door wie" was de hele vraag van shaer-lgo.
            const mij = actorId(base2, site.slug);
            Guardianship.help.record(mark.noteUri, mij, mark.kind, deriveHandle(mij));
          }
          const r = await deliverDirectNote(site, { recipients, text: plain, language: object.language || null, inReplyTo: typeof object.inReplyTo === 'string' ? object.inReplyTo : null, attachments: atts, helpRequest: help, awayUntil, gateRequest: gateReq && gateReq.feature, helpMark: mark });
          if (!r || !r.id) return { status: 502, error: 'direct_failed' };
          return { status: 201, id: r.id, url: `${base}/ap/notes/${r.id}` };
        }
        if (object.inReplyTo) {
          const parent = await resolveRemoteNote(c2sIdOf(object.inReplyTo), { asSlug: site.slug }).catch(() => null);
          if (!parent) return { status: 502, error: 'cannot_resolve_inReplyTo' };
          // The attachments ride along (Robins melding, 30-7: "502
          // reply_failed" op een reply met een foto): deliverReply validates
          // them itself (own /media only, image|audio|video, max 4) and a
          // media-only reply is a valid reply there. Dropping them here made
          // a photo reply arrive naked, and a photo-ONLY reply fail outright.
          const atts = (Array.isArray(object.attachment) ? object.attachment : [])
            .map((a) => a && typeof a === 'object' ? {
              url: String(a.url || '').replace(new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), ''),
              mediaType: String(a.mediaType || ''),
              name: String(a.name || '').slice(0, 120),
            } : null)
            .filter(Boolean);
          // Honour the client's visibility for the reply: 'friends' (followers-
          // only, the Shaer detail-view Reply) drops Public; anything else stays
          // quiet-public. 'direct' was already handled above.
          const r = await deliverReply(site, {
            postId: parent.localPostId || '', postSlug: null, parent, text: plain,
            html: object.content || null, attachments: atts,
            language: object.language || null, visibility: c2sVisibility(object),
          });
          if (!r || !r.id) return { status: 502, error: 'reply_failed' };
          return { status: 201, id: r.id, url: `${base}/ap/notes/${r.id}` };
        }
        return await c2sCreatePost(base, site, user, object);
      }
      // ── Gelezen tot hier (shaer-frontend-3tx) ───────────────────
      //
      // AS2 kent Read: 'the actor has read the object'. Geen shaer:seen
      // verzinnen, en geen zetbare stand: dit is een GEBEURTENIS, dus twee
      // toestellen kunnen elkaar niet terugzetten. Blijft lokaal -- een
      // leesbevestiging heeft in de fediverse niets te zoeken.
      case 'Read': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        const uit = markRead(site.slug, targetUri);
        // Kennen we die note niet, dan is er niets gelezen om te onthouden.
        // Geen fout: een client mag best een oud bericht aanwijzen.
        return { status: uit ? 200 : 202 };
      }
      case 'Like':
      case 'Announce': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        // A non-public local note cannot be boosted or liked into the open
        // (shaer-tqc hardening; the Mastodon 422 equivalent).
        const localPid = postIdFromNoteUrl(targetUri, base);
        if (localPid) {
          const p = db.prepare('SELECT fan_only, ap_visibility FROM posts WHERE id = ?').get(localPid);
          if (p && (p.fan_only || p.ap_visibility === 'direct' || p.ap_visibility === 'friends')) {
            return { status: 403, error: 'not_public' };
          }
        }
        const note = await resolveRemoteNote(targetUri, { asSlug: site.slug }).catch(() => null);
        const objUri = (note && note.object_uri) || targetUri;
        const authorUri = note && note.actor_uri;
        const kind = type === 'Announce' ? 'boost' : 'like';
        await sendInteraction(site, kind, objUri, authorUri);
        // Eén schrijfpad (shaer-9e9): tussentabel + afgeleide vlag in één keer.
        // De note gaat mee zodat een boost de post je tijdlijn in trekt.
        try { setReaction(site.slug, targetUri, kind, true, { flagUri: objUri, note: type === 'Announce' ? note : null }); }
        catch { /* non-fatal: een reactie mag nooit de bezorging blokkeren */ }
        // Een Like uit een app moet ook in ap_timeline.liked landen, want dat
        // is wat de C2S-tijdlijn als shaer:liked teruggeeft. Zonder dit werd
        // de reactie wel opgeslagen (setMyReaction, de webroute leest die),
        // maar kreeg de app altijd liked:false terug: het hartje sprong bij de
        // eerste herlaadbeurt uit, en un-liken kon niet meer -- de app bood
        // alleen nog "Like" aan en stuurde bij elke tik een nieuwe Like.
        // Anders dan bij een boost geen upsert: een like hoort een post niet
        // in je tijdlijn te trekken, dus staat de post er niet in, dan is dit
        // terecht een no-op.
        return { status: 202, url: objUri };
      }
      case 'Follow': {
        const actorUri = c2sIdOf(object);
        if (!actorUri) return { status: 400, error: 'missing_object' };
        // FEP-633c §5.3 outbound (shaer-p729): a ward asks its guardians first.
        // A held request is a THIRD outcome — not sent, not failed — and it
        // travels to the app as one, so Shaer can show "waiting" instead of a
        // tile that already looks followed.
        const held = await gateOutgoingFollow(site, actorUri);
        if (held) {
          return {
            status: 202, url: actorUri, id: held.id,
            state: held.status === 'denied' ? 'refused_by_guardian' : 'awaiting_guardian',
          };
        }
        // The error REACHES the app (Robins melding, 31-7): swallowing it
        // made a failed follow look exactly like a successful one.
        const r = await followActor(site, actorUri);
        if (r && r.error) return { status: 502, error: 'follow_failed', detail: r.error };
        return { status: 202, url: actorUri };
      }
      // Shaer "in Orbit" = a real Block (FEP-c648 client side): lands in
      // ap_blocks, shows in the Block tab, and purges the actor's cached
      // content. Client-side filtering becomes a cache of this state.
      case 'Block': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        const r = await blockTarget(site, targetUri);
        if (r && r.error) return { status: 400, error: r.error };
        return { status: 202, url: targetUri };
      }
      case 'Undo': {
        const inner = object && typeof object === 'object' ? object : null;
        let innerType = inner && inner.type;
        if (Array.isArray(innerType)) innerType = innerType.find((t) => typeof t === 'string');
        const innerTarget = c2sIdOf(inner && inner.object);
        if (innerType === 'Follow') { await unfollowActor(site, innerTarget); return { status: 202, url: innerTarget }; }
        if (innerType === 'Block') {
          if (!innerTarget) return { status: 400, error: 'missing_object' };
          unblock(site, innerTarget);   // release from Orbit
          return { status: 202, url: innerTarget };
        }
        if (innerType === 'Like' || innerType === 'Announce') {
          const kind = innerType === 'Announce' ? 'unboost' : 'unlike';
          const note = await resolveRemoteNote(innerTarget, { asSlug: site.slug }).catch(() => null);
          const objUri = (note && note.object_uri) || innerTarget;
          await sendInteraction(site, kind, objUri, note && note.actor_uri);
          try { setReaction(site.slug, innerTarget, innerType === 'Announce' ? 'boost' : 'like', false, { flagUri: objUri }); }
          catch { /* non-fatal */ }
          return { status: 202, url: objUri };
        }
        return { status: 400, error: 'unsupported_undo' };
      }
      // Delete your OWN note (Robins verzoek, 30-7: long-press delete in de
      // app). Scope stays narrow: this account's posts and outbound replies,
      // nothing else. The web delete route is the model: Tombstone to the
      // followers first, then the cascade, so nobody keeps a live copy of a
      // post the child took back.
      case 'Delete': {
        const targetUri = c2sIdOf(object);
        if (!targetUri) return { status: 400, error: 'missing_object' };
        const pid = postIdFromNoteUrl(targetUri, base);
        if (pid) {
          const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(pid);
          if (post) {
            if (post.site_id !== site.id) return { status: 403, error: 'not_your_note' };
            if (post.status === 'published') deliverDelete(site, post).catch(() => { /* best-effort */ });
            db.transaction(() => {
              db.prepare('DELETE FROM comments WHERE post_id = ?').run(post.id);
              try { db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(post.id); } catch { /* FTS optional */ }
              db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
            })();
            return { status: 202, url: targetUri };
          }
          // Same /ap/notes/ namespace: one of our outbound replies/messages.
          // deliverOutboxDelete checks the site itself and tombstones too.
          if (await deliverOutboxDelete(site, pid)) return { status: 202, url: targetUri };
        }
        return { status: 404, error: 'not_your_note' };
      }
      // Update of arbitrary objects needs the post-edit pipeline; tracked
      // separately (klonkt-demo-c2s-del). Reject clearly rather than half-doing it.
      default:
        return { status: 400, error: 'unsupported_type', detail: String(type || 'none') };
    }
  } catch (e) {
    console.warn('[AP] C2S ingest failed:', e && e.message);
    return { status: 500, error: 'ingest_error' };
  }
}

// Create a top-level microblog post from a C2S Note and federate it. Minimal
// sibling of the /posts/create route: sanitized HTML content, no title/cover.
async function c2sCreatePost(base, site, user, object) {
  const html = HtmlSanitizerService.sanitize(object.content || (object.source && object.source.content) || '');
  // Media on a top-level post (shaer-j3uh/-oqxk/-df3i): same rules as
  // deliverReply — only our OWN uploads, image/audio/video, max 4. They used
  // to be silently dropped here, so a photo post from the app arrived naked.
  const media = (Array.isArray(object.attachment) ? object.attachment : [])
    .filter((a) => a && typeof a.url === 'string' && /^\/media\/[\w./-]+$/.test(a.url)
      && /^(image|audio|video)\//.test(String(a.mediaType || '')))
    .slice(0, 4)
    .map((a) => {
      const entry = { url: a.url, mediaType: String(a.mediaType), name: String(a.name || '').slice(0, 120) };
      // The poster the upload leg made, when it did: a video's still frame
      // (shaer-zowq, .poster.jpg) or an audio's waveform (Robins vraag 30-7,
      // .poster.png). Rides along so the tag, the federated attachment and
      // the apps all have something to show instead of a bare box.
      const posterExt = entry.mediaType.startsWith('video/') ? '.poster.jpg'
        : entry.mediaType.startsWith('audio/') ? '.poster.png' : null;
      if (posterExt) {
        try {
          const mediaRoot = path.resolve(process.env.MEDIA_PATH || './storage/media');
          const rel = entry.url.replace(/^\/media\//, '');
          if (fs.existsSync(path.join(mediaRoot, rel + posterExt))) entry.poster = entry.url + posterExt;
        } catch { /* no poster is fine */ }
      }
      return entry;
    });
  if (!html.trim() && !media.length) return { status: 400, error: 'empty_note' };
  // The web reads the post's content, so the media goes IN it (we build these
  // tags ourselves from validated paths, after the sanitizer). buildNote
  // strips <img> back out into AS2 attachments; audio/video tags stay for the
  // web player and federate via c2s_attachments below.
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const mediaHtml = media.map((a) => {
    if (a.mediaType.startsWith('image/')) return `<p><img src="${a.url}" alt="${esc(a.name)}"></p>`;
    // data-poster: <audio> has no poster attribute, but the tile derivation
    // reads this one to show the waveform (post-tile/post-card).
    if (a.mediaType.startsWith('audio/')) return `<p><audio controls preload="metadata"${a.poster ? ` data-poster="${a.poster}"` : ''} src="${a.url}"></audio></p>`;
    const poster = a.poster ? ` poster="${a.poster}"` : '';
    return `<p><video controls playsinline preload="metadata"${poster} src="${a.url}"></video></p>`;
  }).join('');
  const postId = crypto.randomUUID();
  const slug = 'n-' + postId.slice(0, 8);
  const now = new Date().toISOString();
  // Visibility from the note's addressing (shaer-60b): Public in `to` = loud
  // public, Public in `cc` = quiet public (unlisted), followers-only = friends
  // (rides the existing fan_only pipeline: followers-only AP delivery + web
  // gating), neither = participants-only (kept local until mention addressing
  // lands; still followers-gated on the web).
  const vis = c2sVisibility(object);
  const fanOnly = (vis === 'friends' || vis === 'direct') ? 1 : 0;
  // Deliberately NO cover (Robins besluit, 30-7): the media lives in the
  // content, and a cover next to it showed the same video twice on the post
  // page. The tiles derive their picture from the content instead.
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, excerpt, status, type, language, fan_only, ap_visibility, created_at, updated_at, published_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(postId, site.id, slug, user.id, '', html + mediaHtml, '', 'published', 'post', object.language || 'nl', fanOnly, vis, now, now, now);
  if (media.length) { try { db.prepare('UPDATE posts SET c2s_attachments = ? WHERE id = ?').run(JSON.stringify(media), postId); } catch { /* column exists via ensureColumn */ } }
  try { db.prepare('UPDATE posts SET content_rendered = ? WHERE id = ?').run(bakePostContent(html + mediaHtml), postId); } catch { /* render fallback covers it */ }
  bakePostContentWithMentions(html + mediaHtml).then((h) => { try { db.prepare('UPDATE posts SET content_rendered = ? WHERE id = ?').run(h, postId); } catch { /* keep sync bake */ } }).catch(() => {});
  try { db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?,?,?,?)').run(HtmlSanitizerService.toPlainText(html), '', user.username || '', postId); } catch { /* FTS non-fatal */ }
  if (vis !== 'direct') {
    deliverCreate(site, { id: postId, slug, title: '', content: html + mediaHtml, published_at: now, created_at: now, fan_only: fanOnly, ap_visibility: vis, c2s_attachments: media.length ? JSON.stringify(media) : null }).catch(() => { /* best-effort */ });
  }
  return { status: 201, id: postId, url: `${base}/ap/notes/${postId}` };
}

// The direct-note leg (ward call-for-help) lives in the guardianship module
// (src/services/guardianship/delivery.js); wired with our AP helpers at the
// bottom of this file. Re-exported so every existing caller keeps working.
export const c2sVisibility = Guardianship.c2sVisibility;
export const deliverDirectNote = Guardianship.deliverDirectNote;

// Send a reply FROM this site to a remote actor (in reply to their inbound reply).
// `parent` = an ap_interactions row (actor_uri, actor_url, actor_handle, object_uri).
/**
 * Een gate-voorstel de deur uit (FEP-633c 5.6, shaer-8ru).
 *
 * STOND IN routes/guardian.js en kon daar alleen door de PWA aangeroepen worden.
 * De apps moeten hetzelfde kunnen, en een tweede implementatie ernaast zou een
 * tweede weg naar hetzelfde besluit zijn -- precies de fout die we vandaag bij
 * de antwoordpoort hebben rechtgezet, toen de innamepoort alleen in C2S bleek te
 * zitten en het webpad eromheen liep. Een pad dus.
 *
 * EEN WEG, waar de ward ook woont (Robins regel, 29-7): voorstellen over de
 * lijn en de server van de ward laat tellen. Co-locatie verandert alleen het
 * transport -- deliverToActor lust een lokale ontvanger terug door dezelfde
 * inbox. De oude kortsluiting boekte de stem hier meteen, en zo bleef het
 * remote-pad een maand stuk zonder dat iemand het merkte.
 */
export function proposeGate(site, wardUri, feature, allow) {
  const uri = String(wardUri || '').trim();
  if (!uri) return { status: 400, error: 'empty_uri' };
  if (!Guardianship.gated.featureColumn(feature)) return { status: 400, error: 'unknown_feature' };
  // Alleen een guardian van dit kind. Zonder deze regel zou iedereen met een
  // token een instelling van een vreemd kind kunnen aanvragen.
  if (!Guardianship.listWards(site.slug).some((w) => w.other_uri === uri)) {
    return { status: 403, error: 'not_your_ward' };
  }
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = actorId(base, site.slug);
  const offerId = `${me}/gated/${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const offer = Guardianship.gated.buildGatedOffer(offerId, me, uri, feature, allow);
  // Ons eigen spoor van wat we stuurden: de server van de ward antwoordt op deze
  // Offer zodra het besluit valt, en dat antwoord heeft een rij nodig om in te
  // landen. Het is ook het enige waardoor het scherm van de voorsteller meer kan
  // zeggen dan een knoptekst.
  Guardianship.gated.recordSent(offerId, site.slug, uri, feature, allow);
  deliverToActor(site, uri, offer).catch(() => { /* queued, best-effort */ });
  const localSlug = (base && uri.startsWith(`${base}/`)) ? uri.replace(/\/+$/, '').split('/').pop() : null;
  const progress = localSlug ? Guardianship.gated.gatedProgress(localSlug, feature) : null;
  return { status: 200, ok: true, allow, state: 'open', offerId, ...(progress || { federated: true }) };
}

export async function deliverReply(site, { postId, postSlug, parent, text, html, language, attachments, mentions, visibility }) {
  const _mv = movedRefusal(site, 'reply'); if (_mv) return _mv;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  // Rich replies: `html` is the reply editor's HTML (sanitized here); `text` is
  // the plain-text fallback (no-JS path, C2S `source`). Either may carry the reply.
  const richClean = html ? HtmlSanitizerService.sanitize(String(html)) : '';
  const rich = richClean && HtmlSanitizerService.toPlainText(richClean).trim() ? richClean : '';
  // Attachments: only OUR OWN uploads (/media/... paths, no remote URLs — the
  // upload route is the sole producer), image/audio/video only, max 4.
  const media = (Array.isArray(attachments) ? attachments : [])
    .filter((a) => a && typeof a.url === 'string' && /^\/media\/[\w./-]+$/.test(a.url)
      && /^(image|audio|video)\//.test(String(a.mediaType || '')))
    .slice(0, 4)
    .map((a) => ({ url: a.url, mediaType: String(a.mediaType), name: String(a.name || '').slice(0, 120) }));
  // A media-only reply (no text) is a valid reply.
  if (!base || !site || !site.slug || !parent || (!String(text || '').trim() && !rich && !media.length)) return null;
  // DE POORT STAAT HIER en niet alleen in de outbox (shaer-r4c). routes/posts.js
  // roept deliverReply op drie plekken rechtstreeks aan -- de eigen webinterface
  // van Klonkt gaat dus nooit langs ingestOutboxActivity. Een poort die alleen in
  // C2S staat is een poort met een deur ernaast.
  //
  // Dit is het knooppunt dat beide paden delen. De reddingsboei komt hier niet
  // langs: een hulpvraag is altijd direct en loopt via deliverDirectNote, dus de
  // boei blijft open zonder dat daar een uitzondering voor nodig is.
  {
    const isWard = (() => { try { return Guardianship.listGuardians(site.slug).length > 0; } catch { return false; } })();
    if (!Guardianship.wardGateAllowed(site.gate_replies, isWard)) return null;
  }
  const me = actorId(base, site.slug);
  // u02, the mentions bar: `mentions` undefined = legacy behavior (mention the
  // parent author). An ARRAY (possibly empty) = the kept conversation partners
  // exactly as the bar shows them; the mention prefix, the Mention tags (via
  // mentionTags over the content) and the delivery targets all follow it.
  const kept = Array.isArray(mentions)
    ? mentions
      .filter((m) => m && typeof m.uri === 'string' && /^https?:\/\//i.test(m.uri))
      .slice(0, 8)
      .map((m) => ({
        uri: m.uri,
        url: (typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) ? m.url : m.uri,
        handle: String(m.handle || deriveHandle(m.uri)).slice(0, 120),
      }))
    : null;
  const mentionAnchor = (uri, url, h) => {
    const disp = h && h[0] === '@' ? h : '@' + (h || '');
    return `<a href="${escHtml(url || uri)}" class="u-url mention" data-actor="${escHtml(uri)}">${escHtml(disp)}</a> `;
  };
  const handle = parent.actor_handle || deriveHandle(parent.actor_uri);
  const mention = kept
    ? kept.map((k) => mentionAnchor(k.uri, k.url, k.handle)).join('')
    : (parent.actor_uri ? mentionAnchor(parent.actor_uri, parent.actor_url, handle) : '');
  // Who the stored reply is "to": the parent when kept, else the first kept chip.
  const parentKept = !kept || kept.some((k) => k.uri === parent.actor_uri);
  const toActorUri = parentKept ? (parent.actor_uri || null) : (kept[0] ? kept[0].uri : null);
  const toHandle = parentKept ? handle : (kept[0] ? kept[0].handle : null);
  let content;
  let mres;
  if (rich) {
    // Same enrichment pipeline as the plain path (mentions/hashtags/URLs), on
    // sanitized editor HTML. The parent mention goes inline into the first
    // paragraph (Mastodon convention), or becomes its own leading one.
    mres = await resolveMentionsInText(base, rich);
    const processed = linkUrls(linkHashtags(base, mres.html));
    if (processed.startsWith('<p>')) {
      content = processed.replace('<p>', `<p>${mention}`);            // inline in the first paragraph
    } else if (/^<(blockquote|ul|ol|pre|h[1-6]|div|hr)\b/i.test(processed)) {
      content = `<p>${mention}</p>${processed}`;                      // block content: own leading paragraph
    } else {
      content = `<p>${mention}${processed}</p>`;                      // bare inline text: one paragraph together
    }
  } else {
    const body = escHtml(String(text).trim()).replace(/\r?\n/g, '<br>');
    mres = await resolveMentionsInText(base, body); // link inline @mentions + collect their inboxes
    content = `<p>${mention}${linkUrls(linkHashtags(base, mres.html))}</p>`;
  }
  const replyLang = /^[a-z]{2,3}(-[A-Za-z0-9-]+)?$/.test(String(language || '')) ? language : null;
  // Dedup: skip if the exact same reply was already sent (double-submit guard).
  // Attachments count toward "the same": two media-only replies share content.
  const mediaJson = media.length ? JSON.stringify(media) : null;
  // A duplicate is idempotent success, not an error: it answers with the
  // EXISTING id. Returning without one made the C2S ingest say 502
  // reply_failed on a double-submit (Robins schermafdruk, 30-7), so a retry
  // of a reply the app never showed looked like the reply itself failing.
  const dup = db.prepare('SELECT id FROM ap_outbox WHERE site_slug = ? AND IFNULL(in_reply_to, \'\') = ? AND content = ? AND IFNULL(attachments, \'\') = IFNULL(?, \'\') LIMIT 1')
    .get(site.slug, parent.object_uri || '', content, mediaJson);
  if (dup) { console.log('[AP] outreply skipped (duplicate)'); return { duplicate: true, id: dup.id, delivered: 0 }; }
  const id = crypto.randomUUID();
  iStmts().insO.run(id, site.slug, postId, postSlug || null, parent.object_uri || null, toActorUri, toHandle, content, replyLang, mediaJson);
  // Followers-only reply (shaer detail-view): mark the row so buildNote drops
  // Public from cc. Default (undefined/'public'/'quiet') stays quiet-public.
  if (visibility === 'friends') { try { db.prepare('UPDATE ap_outbox SET visibility = ? WHERE id = ?').run('friends', id); } catch { /* ignore */ } }
  const row = iStmts().getO.get(id);
  const note = buildReplyNote(base, site, row);
  const create = {
    '@context': AP_CONTEXT,
    id: note.id + '#create', type: 'Create', actor: me,
    published: note.published, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const keyId = `${me}#main-key`;
  const inboxes = new Set();
  // Everyone the mentions bar kept gets pinged; legacy path = the parent only.
  const mentionTargets = kept ? kept.map((k) => k.uri) : (parent.actor_uri ? [parent.actor_uri] : []);
  for (const uri of mentionTargets) {
    const a = await fetchActor(uri).catch(() => null);
    if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox);
  }
  if (parent.threadInbox) inboxes.add(parent.threadInbox); // back-compat (single)
  (parent.threadInboxes || []).forEach((i) => inboxes.add(i)); // whole ancestor chain
  for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
  mres.inboxes.forEach((i) => inboxes.add(i)); // people @mentioned inline in the reply
  inboxes.delete(`${me}/inbox`);       // never deliver to ourselves (already in ap_outbox)
  inboxes.delete(`${base}/ap/inbox`);  // (our own shared inbox) → avoids a self-duplicate
  let delivered = 0;
  for (const inbox of [...inboxes].filter(Boolean)) {
    let ok = false;
    try { const st = await deliver(inbox, create, keyId, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, create); // durable: retry a briefly-offline recipient (was silently dropped)
  }
  console.log('[AP] outreply', site.slug, '→', parent.actor_uri, 'delivered', delivered);
  return { id, content, delivered };
}

// attributedTo may be a string, an object {id}, or an ARRAY — e.g. a PeerTube Video is
// attributed to [Person (account), Group (channel)]. Pick a usable actor URI (prefer Person).
function actorUriOf(att) {
  if (!att) return null;
  if (typeof att === 'string') return att;
  if (Array.isArray(att)) {
    const person = att.find((a) => a && typeof a === 'object' && a.type === 'Person' && a.id);
    if (person) return person.id;
    for (const a of att) { if (typeof a === 'string') return a; if (a && a.id) return a.id; }
    return null;
  }
  return att.id || null;
}

// Resolve a remote post URL (any fediverse/Klonkt post) into a reply target.
// Returns a parent-shaped object usable by deliverReply(), or null.
// The server's own note, built straight from the DB. resolveRemoteNote used
// to fetch EVERYTHING over HTTPS, including notes living right here: a
// hairpin fetch fails on home setups (a Klonkt on a Mac behind a tunnel), the
// /ap/notes route rightly hides friends-only posts, and a punycode-spelled
// own URL read as remote on a byte comparison. For the authenticated C2S
// caller none of those walls apply; the DB is one prepare() away.
// `forSlug` is that caller: only the post's own site gets its non-public
// notes on this shortcut (public ones anyone, same as the route serves).
function localNoteObject(url, forSlug) {
  if (!isOwnUrl(url)) return null;
  const m = String(url).match(/\/ap\/notes\/([^/?#]+)/);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const post = db.prepare("SELECT * FROM posts WHERE id = ? AND status = 'published'").get(id);
  if (post) {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(post.site_id);
    if (!site) return null;
    const nonPublic = post.fan_only || post.ap_visibility === 'friends' || post.ap_visibility === 'direct';
    if (nonPublic && (!forSlug || forSlug !== site.slug)) return null;
    return buildNote(base, site, post);
  }
  return getOutboxNote(base, id);   // our own outbound replies
}
// The own actor document, same shortcut, same reason.
function localActorObject(uri) {
  if (!isOwnUrl(uri)) return null;
  const m = String(uri).match(/\/ap\/users\/([^/?#]+)/);
  const site = m ? db.prepare('SELECT * FROM sites WHERE slug = ?').get(decodeURIComponent(m[1])) : null;
  return site ? buildActor((process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''), site) : null;
}

// ── De thread onder een post (shaer-tqz) ───────────────────────────
//
// Klonkt is hier een TOLK, geen archief (Barts besluit, 7-8): de antwoorden
// worden opgehaald op het moment dat iemand kijkt en daarna weer vergeten.
// Geen tabel, geen migratie -- wie replies bewaart van elke post die iemand
// tegenkomt, laat de omvang van zijn database bepalen door surfgedrag. Dat is
// de AFWIJKING, niet de norm: Mastodon serveert /context uit zijn eigen
// database, en dat verdient zich daar terug omdat honderden mensen de cache
// delen. Een Klonkt-instance is de server van één persoon.
//
// Waarom dit niet in de app kan: de replies-collectie van een vreemde server
// eist in secure mode een ONDERTEKEND verzoek, en de sleutel staat hier en kan
// hier niet weg. Voor de opgaande inReplyTo-keten komt de app weg met een
// ongetekende GET (mist er een, jammer); voor een thread van dertig is "de
// helft doet het niet" geen resultaat.
//
// Je krijgt hier NOOIT de hele thread: een replies-collectie bevat alleen wat
// die ene server gezien heeft. De UI hoort "wat de bron weet" te tonen en geen
// volledigheid te suggereren.
// NIET hetzelfde als maybeCrawlThread verderop: die kruipt de thread onder je
// EIGEN posts af en bewaart de antwoorden in ap_interactions (dat zijn de
// jouwe, die horen te blijven). Dit hier is voor een post van een ANDER die je
// tegenkomt, en bewaart niets.
const THREAD_VIEW_LIMIT = 30;
const THREAD_VIEW_TTL_MS = 120_000;
const THREAD_VIEW_CACHE_MAX = 200;
const threadViewCache = new Map();   // `${slug}|${uri}` -> { at, out } -- geheugen, weg bij herstart

/** Eén pagina items uit een AS2-collectie, welke spelling hij ook koos. */
function collectionItems(coll) {
  if (!coll || typeof coll !== 'object') return [];
  const arr = coll.orderedItems || coll.items;
  return Array.isArray(arr) ? arr : [];
}

/**
 * De directe antwoorden op één note, genormaliseerd voor de C2S-lezer.
 *
 * ALLEEN ophalen en normaliseren; de poorten zitten in de route. De
 * kringfilter (de dichte stand van shaer:externalThreads) woont in
 * filterThreadToCircle en de beeld/muziek/emoji-poorten in
 * gateAttachments/stripEmojiTags -- per verzoek, buiten deze cache om, want de
 * stand van een poort mag hier niet twee minuten bevriezen. Geblokkeerde
 * actors zijn een andere categorie en verdwijnen WEL hier, zonder telling:
 * een blokkade is onzichtbaar, ook als getal.
 */
export async function getThread(slug, objectUri) {
  const key = `${slug}|${objectUri}`;
  const hit = threadViewCache.get(key);
  if (hit && Date.now() - hit.at < THREAD_VIEW_TTL_MS) return hit.out;

  // De status waarmee de BRON antwoordde op de note zelf. 401/403/404/410 is
  // een besluit van die server (niet gedeeld, of weg); alles daarbuiten -- ook
  // een stuk netwerk dat wegviel -- is een storing. De route moet dat verschil
  // kunnen zeggen, anders wijst de melding naar de verkeerde partij.
  let sourceStatus = 0;
  const get = (u) => localNoteObject(u, slug) || signedGetJson(slug, u, (st) => { sourceStatus = st; });
  const note = await get(objectUri);
  const repliesRef = note && note.replies;
  let coll = null;
  if (typeof repliesRef === 'string') coll = await signedGetJson(slug, repliesRef);
  else if (repliesRef && typeof repliesRef === 'object') {
    coll = collectionItems(repliesRef).length || repliesRef.first ? repliesRef
      : (repliesRef.id ? await signedGetJson(slug, repliesRef.id) : repliesRef);
  }
  // De pagina-wandeling van collectReplyItems, maar met behoud van INLINE
  // objecten (die niet opnieuw opgehaald hoeven). Niet "de eerste pagina":
  // Mastodon serveert `first` als inline-pagina met LEGE items en een `next`
  // waar de antwoorden echt staan -- wie alleen de eerste pagina leest, ziet
  // op elke Mastodon-post een leeg gesprek. Dat was precies Barts melding
  // (8-8, reacties op een vreemde post). Eigen posts maskeerden het: die
  // gaan door de lokale kortsluiting en hebben orderedItems meteen vol.
  let items = [];
  let node = coll;
  if (node && node.first && !collectionItems(node).length) {
    node = typeof node.first === 'string' ? await signedGetJson(slug, node.first) : node.first;
  }
  let pages = 0;
  while (node && pages++ < 3 && items.length < THREAD_VIEW_LIMIT) {
    items.push(...collectionItems(node));
    if (!node.next) break;
    node = typeof node.next === 'string' ? await signedGetJson(slug, node.next) : node.next;
  }
  items = items.slice(0, THREAD_VIEW_LIMIT);

  // Alles tegelijk in plaats van om de beurt: dertig vreemde servers na elkaar
  // afwachten is een halve minuut kijken naar een spinner.
  const objs = await Promise.all(items.map(async (it) => {
    const o = typeof it === 'string' ? await get(it) : (it && it.object && typeof it.object === 'object' ? it.object : it);
    return (o && o.id && o.attributedTo) ? o : null;
  }));

  const kept = [];
  for (const o of objs) {
    if (!o) continue;
    const actorUri = actorUriOf(o.attributedTo);
    if (!actorUri || isBlockedAny(actorUri)) continue;   // een blokkade telt niet mee
    kept.push({ o, actorUri });
  }

  // Bylines: één fetch per unieke auteur, niet één per antwoord.
  const authors = new Map();
  await Promise.all([...new Set(kept.map((k) => k.actorUri))].map(async (uri) => {
    authors.set(uri, localActorObject(uri) || await signedGetJson(slug, uri).catch(() => null));
  }));

  const notes = kept.map(({ o, actorUri }) => ({
    id: o.id,
    type: 'Note',
    // De ingesloten actor (shaer-nmw): de byline hoort in attributedTo, waar
    // elke AP-lezer hem zoekt, en niet in een eigen property ernaast.
    attributedTo: actorObject(actorUri, actorInfo(authors.get(actorUri), actorUri)),
    inReplyTo: (typeof o.inReplyTo === 'string' ? o.inReplyTo : (o.inReplyTo && o.inReplyTo.id)) || objectUri,
    content: HtmlSanitizerService.sanitize(String(o.content || '').slice(0, 50_000)),
    url: safeUrl(typeof o.url === 'string' ? o.url : (o.url && o.url.href)) || undefined,
    published: typeof o.published === 'string' ? o.published : undefined,
    sensitive: !!o.sensitive,
    summary: (contentWarning(o) || '').slice(0, 500) || undefined,
    attachment: (() => {
      const arr = Array.isArray(o.attachment) ? o.attachment : (o.attachment ? [o.attachment] : []);
      const out = arr.map((a) => ({ type: 'Document', mediaType: (a && a.mediaType) || undefined, url: safeUrl(a && a.url), name: (a && typeof a.name === 'string') ? a.name.slice(0, 1500) : undefined }))
        .filter((a) => a.url);
      return out.length ? out.slice(0, 8) : undefined;
    })(),
    // FEP-9098: de custom emoji van het antwoord (":shortcode:" -> plaatje).
    // Zonder deze tags rendert een reply van een Mastodon-account zijn emoji
    // als kale tekst (Barts punt, 8-8). Alleen naam + geschoond icoon-adres
    // gaan door; de rest van de vreemde tag-array blijft achter.
    tag: (() => {
      const j = extractEmojiTags(o.tag);
      if (!j) return undefined;
      const out = JSON.parse(j)
        .map((t) => ({ type: 'Emoji', name: t.name, icon: { type: 'Image', url: safeUrl(t.icon && (t.icon.url || (Array.isArray(t.icon) && t.icon[0] && t.icon[0].url))) } }))
        .filter((t) => t.icon.url)
        .slice(0, 30);
      return out.length ? out : undefined;
    })(),
  })).sort((a, b) => String(a.published || '').localeCompare(String(b.published || '')));

  const out = { notes, found: !!note, sourceStatus };
  threadViewCache.set(key, { at: Date.now(), out });
  if (threadViewCache.size > THREAD_VIEW_CACHE_MAX) {
    const oldest = [...threadViewCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) threadViewCache.delete(oldest[0]);
  }
  return out;
}

/**
 * De thread gefilterd op de kring die de guardians al kennen (gevolgd of
 * volgend) -- de dichte stand van shaer:externalThreads. PER VERZOEK, buiten de
 * threadcache om: een poort die de guardians net dichtzetten mag niet nog twee
 * minuten open nawerken uit een cache. Wat er buiten valt wordt GETELD, nooit
 * stil weggelaten.
 */
export function filterThreadToCircle(slug, notes) {
  const circle = new Set();
  try { for (const r of db.prepare("SELECT actor_uri FROM ap_following WHERE slug = ? AND status = 'accepted'").all(slug)) circle.add(r.actor_uri); } catch { /* geen tabel */ }
  try { for (const r of db.prepare('SELECT actor_uri FROM ap_followers WHERE slug = ?').all(slug)) circle.add(r.actor_uri); } catch { /* geen tabel */ }
  const kept = [], out = { hidden: 0 };
  for (const n of notes) {
    // actorUriOf, niet n.attributedTo: sinds de byline ingesloten meegaat is
    // dat een OBJECT en zou een kale vergelijking hier stil alles wegfilteren
    // -- een ward met een lege thread en nergens een foutmelding.
    if (circle.has(actorUriOf(n.attributedTo))) kept.push(n);
    else out.hidden += 1;
  }
  out.notes = kept;
  return out;
}

export async function resolveRemoteNote(url, opts = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  // With `asSlug` the fetches are SIGNED as that local actor. An anonymous
  // GET can only read public notes; a friends-only note (Shaer's default!)
  // rightly refuses it, which made every reply to a friend's post fail while
  // a reply to your own public post worked (Robins melding, 30-7). Signed,
  // the other server sees WHO asks and serves what the friendship earns.
  const get = (u) => (opts.asSlug ? signedGetJson(opts.asSlug, u) : fetchActor(u).catch(() => null));
  const note = localNoteObject(url, opts.asSlug) || await get(url); // own DB first, then AP GET
  if (!note || !note.id) return null;
  const att = note.attributedTo;
  const actorUri = actorUriOf(att);
  if (!actorUri) return null;
  const actor = localActorObject(actorUri) || await get(actorUri);
  const ai = actorInfo(actor, actorUri);
  // Is what we're replying to a post (or a comment) on one of OUR posts? If so,
  // link our reply to that local post so it shows nested in the post thread.
  const localTgt = findThreadTarget(note.id, (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''));
  // Walk the WHOLE reply chain upward (comment → parent comment → … → root post)
  // and collect every ancestor author's inbox, so each participant's server —
  // including the original post's author — receives + threads our reply.
  const threadInboxes = [];
  const seenInbox = new Set();
  let cursor = note.inReplyTo, guard = 0;
  while (cursor && guard++ < 6) {
    const url = typeof cursor === 'string' ? cursor : (cursor && cursor.id);
    if (!url) break;
    const pn = localNoteObject(url, opts.asSlug) || await get(url);
    if (!pn) break;
    const pa = actorUriOf(pn.attributedTo);
    if (pa && pa !== actorUri) {
      const paDoc = await get(pa);
      const inbox = paDoc && ((paDoc.endpoints && paDoc.endpoints.sharedInbox) || paDoc.inbox);
      if (inbox && !seenInbox.has(inbox)) { seenInbox.add(inbox); threadInboxes.push(inbox); }
    }
    cursor = pn.inReplyTo; // climb to the next ancestor
  }
  // For non-Note objects (PeerTube Video, Article, …) the meaningful label is `name` (the
  // title); prepend it so the reply page shows what you're replying to (sanitize cleans it).
  let rawHtml = String(note.content || '').replace(/\[\[(track|album|playlist):[^\]]+\]\]/gi, '');
  if (note.name && note.type && note.type !== 'Note') rawHtml = `<p><strong>${note.name}</strong></p>` + rawHtml;
  const images = (Array.isArray(note.attachment) ? note.attachment : [])
    .filter((a) => a && a.url && (!a.mediaType || /^image\//i.test(a.mediaType)))
    .map((a) => safeUrl(a.url)).filter(Boolean);
  // A Klonkt hosted-audio post strips its cover from `attachment` (so Mastodon
  // shows the player card, not a loose image) and puts it in `image` instead.
  // Same fallback as mediaFromNote() so a boosted music post keeps its cover.
  if (!images.length && note.image) {
    const im = Array.isArray(note.image) ? note.image[0] : note.image;
    const iu = safeUrl(typeof im === 'string' ? im : (im && im.url));
    if (iu) images.push(iu);
  }
  return {
    object_uri: safeUrl(note.id) || note.id,
    actor_uri: actorUri,
    actor_url: ai.url,
    actor_handle: ai.handle,
    actor_name: ai.name,
    actor_icon: ai.icon,
    url: note.url || url,
    content: HtmlSanitizerService.sanitize(rawHtml),       // full, sanitized
    sensitive: !!note.sensitive,                            // remote CW → blur in the Cirkel
    cw: contentWarning(note) || '',
    images,
    // Full typed media (incl. video/mp4) for the timeline cache. `images` above is
    // image-only for the interact page preview; a boosted video-only post (Loops)
    // lost its media entirely because upsertBoostedNote only saw `images`.
    media: mediaFromNote(note),
    threadInboxes,                                          // every ancestor author's inbox
    localPostId: localTgt ? localTgt.post_id : '',          // our post this belongs to (if any)
    poll: parsePoll(note),                                  // a Question → its options/counts (else null)
    preview: HtmlSanitizerService.toPlainText(note.content || '').slice(0, 240),
  };
}

// List a site's own outbound fediverse replies (for the manage/delete view).
// The plain editable text of a stored reply (unwrap links → their text, <br> → newline)
// so the manage view can prefill an edit box; the mention is re-added on save.
function outboxEditableText(content) {
  return String(content || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}
export function listOutbox(siteSlug) {
  // post_slug reist mee sinds Berichten gesprekken toont: het is de sleutel
  // waarop een verzonden antwoord bij de ontvangen antwoorden op dezelfde post
  // gaat staan (zie threadKey). Zonder die kolom viel een uitwisseling uit
  // elkaar in "Verzonden" en "Gesprekken".
  return db.prepare('SELECT id, content, to_handle, to_actor, to_actors, post_slug, in_reply_to, attachments, language, created_at FROM ap_outbox WHERE site_slug = ? ORDER BY created_at DESC')
    .all(siteSlug).map((r) => { const c = stripLeadingMentions(r.content); return { ...r, content: c, editable: outboxEditableText(c) }; });
}

// Delete one of our outbound replies: send Delete(Tombstone) to recipients + remove it.
export async function deliverOutboxDelete(site, outboxId) {
  const row = iStmts().getO.get(outboxId);
  if (!row || row.site_slug !== site.slug) return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (base) {
    const me = actorId(base, site.slug);
    const nid = noteId(base, row.id);
    const del = { '@context': AP_CONTEXT, id: `${nid}#delete-${Date.now()}-${rid()}`, type: 'Delete', actor: me, to: [PUBLIC], object: { id: nid, type: 'Tombstone' } };
    const keys = getOrCreateKeys(site.slug);
    const inboxes = new Set();
    if (row.to_actor) { const a = await fetchActor(row.to_actor).catch(() => null); if (a) inboxes.add((a.endpoints && a.endpoints.sharedInbox) || a.inbox); }
    for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
    for (const inbox of [...inboxes].filter(Boolean)) {
      try { const st = await deliver(inbox, del, `${me}#main-key`, keys.private_pem); if (st >= 200 && st < 300) continue; } catch { /* queue below */ }
      enqueueDelivery(site.slug, inbox, del); // durable: a failed comment-delete now retries (was silently dropped)
    }
  }
  db.prepare('DELETE FROM ap_outbox WHERE id = ?').run(outboxId);
  return true;
}

// Edit one of our outbound replies: rewrite the stored content (mention re-added + #tags
// re-linked) and send an Update(Note) so recipients refresh their cached copy.
export async function deliverOutboxUpdate(site, outboxId, newText, opts = {}) {
  const row = iStmts().getO.get(outboxId);
  if (!row || row.site_slug !== site.slug) return false;
  const text = String(newText || '').trim();
  // Rich edit: same sanitize + enrichment pipeline as deliverReply.
  const richClean = opts.html ? HtmlSanitizerService.sanitize(String(opts.html)) : '';
  const rich = richClean && HtmlSanitizerService.toPlainText(richClean).trim() ? richClean : '';
  if (!text && !rich) return false;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return false;
  const me = actorId(base, site.slug);
  const toActor = row.to_actor ? await fetchActor(row.to_actor).catch(() => null) : null;
  const toProfile = row.to_actor ? (actorInfo(toActor, row.to_actor).url || row.to_actor) : '';
  const _h = row.to_handle || deriveHandle(row.to_actor);
  const toHandle = _h && _h[0] === '@' ? _h : '@' + (_h || '');
  // An edit must not drop co-mentions (u02): reuse the OLD content's leading
  // mention anchors (the bar's kept list at send time) when present; only fall
  // back to rebuilding the single to_actor mention for legacy rows.
  const oldPrefix = (String(row.content || '')
    .match(/^\s*(?:<p[^>]*>)?\s*((?:<a\b[^>]*class="u-url mention"[^>]*>\s*@[^<]+<\/a>[\s ]*)+)/i) || [])[1] || '';
  const mention = oldPrefix || (row.to_actor
    ? `<a href="${escHtml(toProfile)}" class="u-url mention" data-actor="${escHtml(row.to_actor)}">${escHtml(toHandle)}</a> ` : '');
  let content;
  let mres;
  if (rich) {
    mres = await resolveMentionsInText(base, rich);
    const processed = linkUrls(linkHashtags(base, mres.html));
    if (processed.startsWith('<p>')) content = processed.replace('<p>', `<p>${mention}`);
    else if (/^<(blockquote|ul|ol|pre|h[1-6]|div|hr)\b/i.test(processed)) content = `<p>${mention}</p>${processed}`;
    else content = `<p>${mention}${processed}</p>`;
  } else {
    mres = await resolveMentionsInText(base, escHtml(text).replace(/\r?\n/g, '<br>'));
    content = `<p>${mention}${linkUrls(linkHashtags(base, mres.html))}</p>`;
  }
  // Language may be updated with the edit; attachments always survive untouched.
  const newLang = /^[a-z]{2,3}(-[A-Za-z0-9-]+)?$/.test(String(opts.language || '')) ? opts.language : null;
  db.prepare('UPDATE ap_outbox SET content = ?, language = COALESCE(?, language) WHERE id = ?').run(content, newLang, outboxId);
  const note = buildReplyNote(base, site, iStmts().getO.get(outboxId));
  note.updated = new Date().toISOString();
  const update = {
    '@context': AP_CONTEXT,
    id: `${note.id}#update-${Date.now()}-${rid()}`, type: 'Update', actor: me,
    published: note.published, updated: note.updated, to: note.to, cc: note.cc, object: note,
  };
  const keys = getOrCreateKeys(site.slug);
  const inboxes = new Set();
  if (toActor) inboxes.add((toActor.endpoints && toActor.endpoints.sharedInbox) || toActor.inbox);
  for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox);
  mres.inboxes.forEach((i) => inboxes.add(i)); // people @mentioned inline in the edit
  inboxes.delete(`${me}/inbox`); inboxes.delete(`${base}/ap/inbox`);
  let delivered = 0;
  for (const inbox of [...inboxes].filter(Boolean)) {
    let ok = false;
    try { const st = await deliver(inbox, update, `${me}#main-key`, keys.private_pem); ok = st >= 200 && st < 300; } catch { ok = false; }
    if (ok) delivered++;
    else enqueueDelivery(site.slug, inbox, update); // durable: retry the edit later (was silently dropped)
  }
  console.log('[AP] outreply edit', site.slug, 'delivered', delivered);
  return { ok: true, content, delivered };
}

// ── Fediverse CLIENT: follow accounts + home timeline ─────────────
// Resolve an @user@domain handle to its actor URL via WebFinger.
export async function webfingerResolve(handle) {
  const h = String(handle || '').trim().replace(/^@/, '');
  const parts = h.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const acct = `${parts[0]}@${parts[1]}`;
  try {
    const r = await safeFetch(`https://${parts[1]}/.well-known/webfinger?resource=acct:${encodeURIComponent(acct)}`,
      { headers: { Accept: 'application/jrd+json, application/json' } });
    if (!r.ok) return null;
    const jrd = await r.json();
    const link = (jrd.links || []).find((l) => l.rel === 'self' && /activity\+json|ld\+json/.test(l.type || ''));
    return safeUrl(link ? link.href : '') || null;
  } catch { return null; }
}

let _insFw, _delFw, _listFw, _accFw, _accFwByActor, _oneFw, _setAB;
function fwStmts() {
  if (!_insFw) {
    _insFw = db.prepare('INSERT OR REPLACE INTO ap_following (slug, actor_uri, handle, name, icon, url, inbox, follow_id, status, auto_boost, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _delFw = db.prepare('DELETE FROM ap_following WHERE slug = ? AND actor_uri = ?');
    _listFw = db.prepare('SELECT * FROM ap_following WHERE slug = ? ORDER BY created_at DESC');
    _accFw = db.prepare("UPDATE ap_following SET status = 'accepted' WHERE follow_id = ?");
    // Terugval als de Accept ons follow-id niet teruggeeft (zie de Accept-tak
    // in handleInbox): dan is het paar dat we WEL zeker weten (deze site, deze
    // actor) genoeg, mits de rij nog op pending staat.
    _accFwByActor = db.prepare("UPDATE ap_following SET status = 'accepted' WHERE slug = ? AND actor_uri = ? AND status = 'pending'");
    _oneFw = db.prepare('SELECT * FROM ap_following WHERE slug = ? AND actor_uri = ?');
    _setAB = db.prepare('UPDATE ap_following SET auto_boost = ? WHERE slug = ? AND actor_uri = ?');
  }
  return { ins: _insFw, del: _delFw, list: _listFw, acc: _accFw, accByActor: _accFwByActor, one: _oneFw, setAB: _setAB };
}
export function listFollowing(slug) { return fwStmts().list.all(slug); }

// Toggle auto-boost ("feature") on an account we already follow.
export function setAutoBoost(slug, actorUri, on) {
  try { fwStmts().setAB.run(on ? 1 : 0, slug, actorUri); } catch { /* ignore */ }
  // Featuring an account → AP-native catch-up so the Cirkel isn't empty until they next
  // post (push doesn't backfill history-before-follow). Fire-and-forget pull, sends nothing.
  if (on) backfillFromOutbox(slug, actorUri).catch(() => {});
  return { ok: true };
}

let _insTl, _listTl, _delTl;
function tlStmts() {
  if (!_insTl) {
    _insTl = db.prepare('INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, author_handle, author_icon, author_url, content, url, published, media_json, nsfw, cw, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listTl = db.prepare('SELECT * FROM ap_timeline WHERE slug = ? ORDER BY COALESCE(published, created_at) DESC LIMIT ? OFFSET ?');
    _delTl = db.prepare('DELETE FROM ap_timeline WHERE id = ?');
  }
  return { ins: _insTl, list: _listTl, del: _delTl };
}
/**
 * De tijdlijn, met liked/boosted uit de TUSSENTABEL (shaer-9e9).
 *
 * De rijen komen met SELECT *, dus ap_timeline.liked en .boosted liften mee --
 * en die zijn sinds fase 1 nog maar een afgeleide. De Krant tekende zijn
 * knoppen daar wel op, terwijl de toggle al uit getReaction besliste: tekenen en
 * beslissen leunden dus op verschillende bronnen. Ze waren het eens zolang de
 * migratie ze gelijk hield, maar dat was synchronisatie en geen ontwerp.
 *
 * Bewust in JS en niet als join: met SELECT * zouden twee kolommen `liked`
 * heten en hangt het van de driver af welke wint. Eén extra query per pagina
 * (dezelfde batch die de C2S-tijdlijn gebruikt) is dat niet waard.
 */
export function getTimeline(slug, limit, offset) {
  const rows = tlStmts().list.all(slug, limit || 50, offset || 0);
  const reacties = getReactionsFor(slug, rows.map((r) => r.id));
  for (const r of rows) {
    const x = reacties.get(r.id);
    r.liked = !!(x && x.liked);
    r.boosted = !!(x && x.boosted);
  }
  return rows;
}

/**
 * The direct notes addressed to this account: a plain DM, a guardian's wave
 * (§5), a ward's 🛟 help request (§5.2.1). They live in ap_mentions and NOT in
 * the timeline, because a note addressed to named people is a message and not a
 * post (belongsInTimeline).
 *
 * A client that only reads the timeline therefore sees none of them, which is
 * exactly what happened to Shaer: Berichten showed your own replies (those come
 * from your outbox) and nothing that was said to you. The C2S inbox read serves
 * both, so the app has one door for everything that arrives.
 *
 * A public mention from someone you follow is stored in both tables; those are
 * skipped here and stay a post.
 */
// Inbound replies on YOUR posts, for the app's message stream. They live in
// ap_interactions (the web's comment machinery) and deliberately NOT in
// ap_mentions (the mention store returns early for replies-to-us), so the
// C2S read missed them entirely: a reply arrived at the other side
// everywhere EXCEPT in the other's app (Robins melding, 30-7: "komt niet
// binnen bij de ander").
const REPLY_COLUMNS = `
      i.object_uri, i.actor_uri, i.actor_name, i.actor_handle, i.actor_icon, i.actor_url,
      i.content, i.published, i.created_at, i.parent_uri, i.post_id,
      i.emoji_json, i.actor_emoji_json, i.media_json, i.quote_json, i.embed_json`;

/** Dezelfde antwoordrijen, maar op object-uri -- voor de verschil-lezing. */
export function replyRowsByUri(slug, uris) {
  const list = (uris || []).filter((u) => typeof u === 'string' && u);
  if (!list.length) return [];
  try {
    const holes = list.map(() => '?').join(',');
    return db.prepare(`SELECT ${REPLY_COLUMNS} FROM ap_interactions i
                        JOIN posts p ON p.id = i.post_id
                        JOIN sites s ON s.id = p.site_id
                       WHERE s.slug = ? AND i.kind = 'reply' AND i.object_uri IN (${holes})`)
      .all(slug, ...list);
  } catch { return []; }
}

/** Tijdlijnrijen op id, met dezelfde afgeleide liked/boosted als getTimeline. */
export function timelineRowsByIds(slug, ids) {
  const list = (ids || []).filter((u) => typeof u === 'string' && u);
  if (!list.length) return [];
  try {
    const holes = list.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM ap_timeline WHERE slug = ? AND id IN (${holes})`).all(slug, ...list);
    const reacties = getReactionsFor(slug, rows.map((r) => r.id));
    for (const r of rows) {
      const x = reacties.get(r.id);
      r.liked = !!(x && x.liked);
      r.boosted = !!(x && x.boosted);
    }
    return rows;
  } catch { return []; }
}

export function getReplyMessages(slug, limit) {
  try {
    return db.prepare(`
      SELECT ${REPLY_COLUMNS}
      FROM ap_interactions i
      JOIN posts p ON p.id = i.post_id
      JOIN sites s ON s.id = p.site_id
      WHERE s.slug = ? AND i.kind = 'reply'
      ORDER BY COALESCE(i.published, i.created_at) DESC LIMIT ?`).all(slug, limit || 60);
  } catch { return []; }
}

/**
 * Een merk voor "is er iets veranderd aan wat de inbox-lezing zou opleveren?"
 * (shaer-n05).
 *
 * Alle VIER de poten die de inbox samenvoegt tellen mee -- tijdlijn, berichten,
 * antwoorden op je eigen posts, en wat je zelf verstuurde. Zou er een ontbreken,
 * dan blijft een wachtende client slapen terwijl er wel degelijk iets is
 * bijgekomen, en dat is erger dan niet wachten: het lijkt te werken.
 *
 * rowid en niet een tijdstempel: rowid loopt strikt op per invoeging, terwijl
 * twee dingen in dezelfde seconde kunnen aankomen en een `published` van een
 * andere server niet te vertrouwen is.
 *
 * Ondoorzichtig voor de client. Hij krijgt hem terug en geeft hem ongewijzigd
 * mee; de vorm mag veranderen zonder dat dat iets breekt.
 */
export function feedCursor(slug) {
  try {
    const r = db.prepare('SELECT MAX(rev) AS n FROM ap_feed_state WHERE slug = ?').get(slug);
    return String((r && r.n) || 0);
  } catch { return '0'; }
}

/**
 * Wat er sinds `rev` met deze tijdlijn gebeurd is: welke berichten er nieuw zijn,
 * bewerkt, of weg.
 *
 * Nog niet gebruikt door een leespad -- de vorm van de aankomst is shaer-of7 en
 * de "bewerkt"-markering is daar nog een open beslissing. Maar de gegevens
 * ontstaan hoe dan ook bij het bijhouden van de merksteen, en dit is de enige
 * plek waar ze samen te lezen zijn.
 */
export function feedChangesSince(slug, rev, limit = 200) {
  try {
    return db.prepare(`SELECT object_uri, kind, rev FROM ap_feed_state
                        WHERE slug = ? AND rev > ? ORDER BY rev ASC LIMIT ?`)
      .all(slug, parseInt(rev, 10) || 0, limit);
  } catch { return []; }
}

// Zoveel clients mogen er tegelijk op EEN account staan wachten. Een client met
// een kapotte herverbind-lus mag de instance niet vastzetten; de overtolligen
// krijgen gewoon meteen antwoord in plaats van een fout.
const FEED_WAIT_MAX = 4;
const _wachters = new Map();

/**
 * Wacht tot de inbox-lezing iets anders zou opleveren dan bij `since`.
 *
 * Bewust met een interne tik en niet met een gebeurtenis-emitter. Een emitter
 * moet op ELKE plek worden aangeroepen waar er iets bijkomt, en de plek die je
 * vergeet is precies de melding die nooit aankomt. Twee tot vier MAX(rowid)-
 * queries per seconde is niets, en dit kan niets missen. Prijs: hooguit een tik
 * vertraging.
 */
export async function waitForFeedChange(slug, opts = {}) {
  const tickMs = Math.max(50, opts.tickMs || 1000);
  const waitMs = Math.max(0, opts.waitMs || 0);
  const since = String(opts.since || '');
  let cursor = feedCursor(slug);
  // Geen sinds, al iets veranderd, of niet willen wachten: meteen antwoorden.
  if (!since || since !== cursor || !waitMs) return { cursor, changed: !!since && since !== cursor, waited: false };

  const bezet = _wachters.get(slug) || 0;
  if (bezet >= FEED_WAIT_MAX) return { cursor, changed: false, waited: false, busy: true };
  _wachters.set(slug, bezet + 1);
  try {
    const einde = Date.now() + waitMs;
    while (Date.now() < einde) {
      if (opts.signal && opts.signal.aborted) break;   // client hing op
      const rest = Math.min(tickMs, einde - Date.now());
      await new Promise((r) => setTimeout(r, rest));
      cursor = feedCursor(slug);
      if (cursor !== since) return { cursor, changed: true, waited: true };
    }
    return { cursor, changed: false, waited: true };
  } finally {
    const n = (_wachters.get(slug) || 1) - 1;
    if (n > 0) _wachters.set(slug, n); else _wachters.delete(slug);
  }
}

// ── Gesprekken: eerst wie, dan pas wat (shaer-frontend-yso) ──────────
//
// De oude lezing gaf de nieuwste 60 berichten over ALLE gesprekken samen. Dat
// knipt geschiedenis weg zonder dat iemand het merkt, en het is bij DM's veel
// erger dan bij posts: dat zijn er meer en het zijn kortere berichten, dus een
// druk gesprek kan de 60 in zijn eentje opeten en de rest uit de lezing duwen.
// Viel het laatste bericht van iemand erbuiten, dan verdween die persoon
// helemaal uit Messages -- de avatarhemel plaatst mensen op de leeftijd van hun
// laatste bericht, dus geen bericht is geen gezicht.
//
// Vandaar twee lezingen. Deze geeft EEN rij per tegenpartij, hoe druk iemand
// ook is, en conversationHistory hieronder geeft het gesprek zelf met een
// cursor. Wat de client van de hemel nodig heeft -- wie, wanneer, en waarmee --
// zit in die ene nieuwste note.
//
// Een gesprek is hier hetzelfde als in de app: incoming zijn de ap_mentions
// (die tabel IS de aan ons gerichte post), uitgaand zijn de eigen notes met
// visibility 'direct'. Een publiek antwoord is geen gesprek en hoort niet als
// gezicht in de hemel.
/**
 * EEN STEMPEL IN EEN VORM, en dat is hier geen netheid maar de volgorde zelf.
 *
 * Drie vormen kwamen samen in deze unie: `2026-08-13 19:26:17` van SQLite's
 * CURRENT_TIMESTAMP, `2026-08-13T18:21:57Z` uit een object, en dezelfde met
 * milliseconden. Als TEKST vergeleken staat op plek 10 een spatie tegen een
 * T -- en een spatie is kleiner. Dus sorteerde binnen dezelfde dag alles wat
 * JIJ stuurde vóór alles wat binnenkwam, ongeacht de klok (Barts melding 14-8:
 * een bericht van 00:30 stond boven een antwoord van 20:22 de avond ervoor).
 *
 * strftime leest alle drie en geeft er een vorm voor terug, in UTC. Lukt het
 * niet, dan blijft de rauwe waarde staan -- dan is die ene rij verkeerd
 * gesorteerd in plaats van de hele lijst.
 *
 * Dit gaat ook de client aan: `new Date('2026-08-13 19:26:17')` leest in
 * JavaScript als LOKALE tijd en `...T19:26:17Z` als UTC. Dezelfde rij gaf dus
 * een leeftijd die twee uur verschilde per vorm.
 */
const STEMPEL = (rauw) => `COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', ${rauw}), ${rauw})`;

const CONVERSATION_UNION = `
  SELECT m.actor_uri AS other, ${STEMPEL('COALESCE(m.published, m.created_at)')} AS stamp,
         'in' AS direction, m.object_uri AS ref
    FROM ap_mentions m
   WHERE m.slug = @slug AND m.actor_uri IS NOT NULL AND m.actor_uri <> ''
  UNION ALL
  SELECT j.value AS other, ${STEMPEL('o.created_at')} AS stamp,
         'out' AS direction, o.id AS ref
    FROM ap_outbox o
    JOIN json_each(COALESCE(NULLIF(o.to_actors, ''), json_array(o.to_actor))) j
   WHERE o.site_slug = @slug AND o.visibility = 'direct'
     AND j.value IS NOT NULL AND j.value <> ''`;

/**
 * Een rij per tegenpartij: zijn nieuwste bericht, nieuwste gesprek eerst.
 *
 * Compleet van vorm -- het aantal rijen is het aantal mensen, niet het aantal
 * berichten -- dus de hemel kan niemand meer kwijtraken doordat een ander druk
 * was. Zonder limiet, en dat mag: dit schaalt met je kring.
 */
export function conversationHeads(slug) {
  try {
    // Twee rijen per persoon, niet een: het nieuwste bericht (dat bepaalt waar
    // iemand in de hemel hangt) EN het nieuwste bericht VAN HEM.
    //
    // Die tweede is er omdat het nieuwste bericht van jou kan zijn, en dan
    // draagt het jouw byline. De hemel zoekt de naam en het gezicht van de
    // ander in een bericht van de ander -- vond hij dat niet, dan viel hij
    // terug op het staartje van de actor-uri en heette tante opeens
    // 'hotelbreakfast'. Op het toestel gezien, 10-8.
    //
    // Valt het samen (het nieuwste is al van hem), dan is het een rij; dubbel
    // sturen doen we niet.
    return db.prepare(`
      SELECT other, stamp, direction, ref FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY other ORDER BY stamp DESC, ref DESC) AS rn
          FROM (${CONVERSATION_UNION})
      ) WHERE rn = 1
      UNION
      SELECT other, stamp, direction, ref FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY other ORDER BY stamp DESC, ref DESC) AS rn
          FROM (${CONVERSATION_UNION}) WHERE direction = 'in'
      ) WHERE rn = 1
      ORDER BY stamp DESC, ref DESC`).all({ slug });
  } catch { return []; }
}

/**
 * Een gesprek, nieuwste eerst, met een cursor.
 *
 * BEIDE KANTEN ONDER EEN LIMIET. In de oude lezing werden jouw kant
 * (getSentNotes) en hun kant apart afgekapt, waardoor een gesprek eenzijdig
 * kon lijken -- alsof iemand nooit geantwoord had. Hier is de limiet er een
 * voor het gesprek als geheel.
 *
 * `before` is de cursor van het OUDSTE bericht dat je al hebt; je krijgt wat
 * daarvoor ligt. Er komt er een extra op om te weten of er nog meer is: de
 * client hoort dat te weten zonder te moeten gokken, en zonder dat weten kan
 * 'load more' niet eerlijk verschijnen.
 *
 * DE CURSOR IS SAMENGESTELD -- '<stempel>|<ref>' -- en niet alleen de stempel.
 * Twee berichten in dezelfde seconde is bij DM's geen randgeval maar een
 * gesprek, en met 'stamp < before' zou alles wat die grensseconde deelt stil
 * overgeslagen worden. Je zou het niet merken: de pagina komt gewoon, er
 * ontbreekt alleen iets in het midden.
 */
const cursorOf = (r) => (r ? `${r.stamp}|${r.ref}` : null);

export function conversationHistory(slug, other, { before = null, limit = 60 } = {}) {
  try {
    const n = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
    const sep = String(before || '').indexOf('|');
    const bStamp = before && sep > 0 ? String(before).slice(0, sep) : null;
    const bRef = before && sep > 0 ? String(before).slice(sep + 1) : null;
    const rows = db.prepare(`
      SELECT other, stamp, direction, ref FROM (${CONVERSATION_UNION})
       WHERE other = @other
         AND (@bStamp IS NULL OR stamp < @bStamp OR (stamp = @bStamp AND ref < @bRef))
       ORDER BY stamp DESC, ref DESC LIMIT @n`).all({ slug, other, bStamp, bRef, n: n + 1 });
    const more = rows.length > n;
    const page = more ? rows.slice(0, n) : rows;
    return { rows: page, more, oldest: cursorOf(page[page.length - 1]) };
  } catch { return { rows: [], more: false, oldest: null }; }
}

// De kolommen die een bericht tot kaart maken. Een constante, want de
// gesprekslezing haalt dezelfde rows op: twee lijsten die uiteenlopen leveren
// een kaart die op de ene plek een plaatje heeft en op de andere niet.
const MESSAGE_COLUMNS = `
      m.object_uri, m.note_url, m.actor_uri, m.actor_name, m.actor_handle, m.actor_icon, m.actor_url,
      m.content, m.published, m.created_at, m.wave, m.help_request,
      m.emoji_json, m.actor_emoji_json, m.media_json, m.quote_json, m.embed_json`;

/** Dezelfde berichtrijen, maar op object-uri -- voor een gesprek. */
export function messageRowsByUri(slug, uris) {
  const lijst = (uris || []).filter((u) => typeof u === 'string' && u);
  if (!lijst.length) return [];
  try {
    const gaten = lijst.map(() => '?').join(',');
    return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM ap_mentions m
                        WHERE m.slug = ? AND m.object_uri IN (${gaten})`).all(slug, ...lijst);
  } catch { return []; }
}

/**
 * Tot waar deze lezer elk gesprek gelezen heeft (shaer-frontend-3tx).
 *
 * De markering komt uit AS2 `Read`-activiteiten, en die zijn OPTELLEND: het
 * lezen van bericht N maakt niets anders ongelezen. Daarom is achteruit gaan
 * geen regel die iemand moet onthouden maar een eigenschap van het model --
 * markRead neemt het maximum. Een 'zet mijn markering op X' zou een toestel
 * dat een week uit stond je gelezen berichten weer op ongelezen laten zetten.
 */
export function readMarkers(slug) {
  try {
    return new Map(db.prepare('SELECT other, cursor FROM ap_read_markers WHERE slug = ?')
      .all(slug).map((r) => [r.other, r.cursor]));
  } catch { return new Map(); }
}

/**
 * Markeer een gesprek als gelezen tot en met dit bericht.
 *
 * Het object van de Read is een berichturi; welk gesprek dat is en waar het in
 * de tijd staat weet de server zelf, dus de client hoeft niets uit te rekenen
 * en kan er ook niet naast zitten.
 */
export function markRead(slug, objectUri) {
  try {
    const rij = db.prepare(`SELECT other, stamp, ref FROM (${CONVERSATION_UNION})
                             WHERE ref = @ref ORDER BY stamp DESC LIMIT 1`)
      .get({ slug, ref: String(objectUri || '') });
    if (!rij) return null;
    const cursor = `${rij.stamp}|${rij.ref}`;
    db.prepare(`INSERT INTO ap_read_markers (slug, other, cursor) VALUES (?,?,?)
                ON CONFLICT(slug, other) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), at = CURRENT_TIMESTAMP`)
      .run(slug, rij.other, cursor);
    return { other: rij.other, cursor };
  } catch { return null; }
}

/**
 * Hoeveel er per gesprek nog ongelezen is, en of daar een zwaai bij zit.
 *
 * Een COUNT en geen bijgehouden getal (Barts besluit): niets om op te hogen
 * bij bezorging, niets om te verlagen bij lezen, en bij een verwijdering klopt
 * het vanzelf weer.
 *
 * Een zwaai telt apart, want dat is geen gesprek maar een zetje van een
 * guardian -- die hoort een eigen teken te krijgen en niet opgeteld te worden.
 * Eigen berichten tellen nooit mee: je hebt jezelf gelezen.
 */
export function unreadPerConversation(slug, { messagesAllowed = true, guardians = new Set() } = {}) {
  try {
    // DE POORT TELT MEE. Staat messages dicht, dan toont de app die berichten
    // niet -- en dan mag een badge ze ook niet aankondigen, want dat getal
    // vertelt precies wat de poort verbergt. Wat er altijd door mag telt wel:
    // het guardian-kanaal en de boei. Zelfde regel als bij de serialisatie.
    const rijen = db.prepare(`
      SELECT u.other AS other,
             COUNT(*) AS n,
             MAX(CASE WHEN m.wave = 1 THEN 1 ELSE 0 END) AS wave
        FROM (${CONVERSATION_UNION}) u
        LEFT JOIN ap_read_markers r ON r.slug = @slug AND r.other = u.other
        LEFT JOIN ap_mentions m ON m.slug = @slug AND m.object_uri = u.ref
       WHERE u.direction = 'in'
         AND (r.cursor IS NULL OR (u.stamp || '|' || u.ref) > r.cursor)
         AND (@open = 1 OR m.help_request = 1 OR u.other IN (SELECT value FROM json_each(@guardians)))
       GROUP BY u.other`)
      .all({ slug, open: messagesAllowed ? 1 : 0, guardians: JSON.stringify([...guardians]) });
    return new Map(rijen.map((r) => [r.other, { n: r.n, wave: !!r.wave }]));
  } catch { return new Map(); }
}

export function getDirectMessages(slug, limit) {
  try {
    return db.prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM ap_mentions m
      WHERE m.slug = ?
        AND NOT EXISTS (SELECT 1 FROM ap_timeline t WHERE t.slug = m.slug AND t.id = m.object_uri)
      ORDER BY COALESCE(m.published, m.created_at) DESC LIMIT ?`).all(slug, limit || 60);
  } catch { return []; }
}

/**
 * A stored stamp as an ISO instant. SQLite's CURRENT_TIMESTAMP writes
 * 'YYYY-MM-DD HH:MM:SS' in UTC, which Date.parse reads as LOCAL time; on a
 * server two hours ahead that dated every message two hours early and put the
 * conversation in the wrong order. A `published` from the wire is already ISO
 * and passes through untouched.
 */
export function isoStamp(v) {
  if (!v) return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Inbox C2S read: a timeline row's media_json ([{url, type}], written on the
// inbound Create) → AS2 `attachment` array, so a client (Shaer) can render a
// friend's images/audio/video natively, exactly like own outbox posts. The
// stored `type` is the mediaType and may be ''. Malformed JSON yields
// undefined and never blocks the item.
export function timelineAttachments(mediaJson) {
  try {
    const list = mediaJson ? JSON.parse(mediaJson) : [];
    const rows = (Array.isArray(list) ? list : [])
      .filter((m) => m && m.url)
      .map((m) => {
        const a = { type: 'Document', mediaType: m.type || undefined, url: m.url };
        if (m.poster) a.icon = { type: 'Image', url: m.poster }; // the video's still (shaer-zowq)
        return a;
      });
    return rows.length ? rows : undefined;
  } catch { return undefined; }
}

// FEP-9098 custom emojis. Inbound: keep the note's Emoji tags (as JSON) so we
// can serve them back. `extractEmojiTags` returns the JSON to store (or null);
// `timelineEmojis` turns the stored JSON back into an AS2 `tag` array for the
// C2S inbox read, so a client (Shaer) can render :shortcode: as an image.
export function extractEmojiTags(tag) {
  const arr = Array.isArray(tag) ? tag : (tag ? [tag] : []);
  const emojis = arr.filter((t) => t && (Array.isArray(t.type) ? t.type[0] : t.type) === 'Emoji'
    && typeof t.name === 'string' && t.icon);
  return emojis.length ? JSON.stringify(emojis) : null;
}
// ── Gate-filters voor de C2S-serialisatie (shaer-ahy.1, 8-8) ──────
//
// Dezelfde regel als bij de embeds: de poort zit bij de AFLEVERING. Een
// bijlage die de client alleen verbergt is wel degelijk geleverd, dus wat
// dicht is wordt hier nooit geserialiseerd. Puur, zodat de regels los van de
// routes te toetsen zijn.

/** Bijlagen door de beeld- en muziekpoort. Leeg wordt undefined, zoals de
 *  serialisatie dat overal doet. */
export function gateAttachments(atts, { images = true, audio = true } = {}) {
  if (!Array.isArray(atts)) return atts;
  const out = atts.filter((a) => {
    const mt = String((a && a.mediaType) || '');
    if (!images && mt.startsWith('image/')) return false;
    if (!audio && (mt.startsWith('audio/') || (a && a.type === 'Audio'))) return false;
    return true;
  });
  return out.length ? out : undefined;
}

/** Tag-array zonder de FEP-9098 Emoji-tags, voor een dichte emoji-poort. De
 *  :shortcode: blijft als tekst staan -- dat is eerlijk: er STAAT iets, het
 *  wordt alleen niet als plaatje van een vreemde server gerenderd. */
export function stripEmojiTags(tags) {
  if (!Array.isArray(tags)) return tags;
  const out = tags.filter((t) => (Array.isArray(t && t.type) ? t.type[0] : (t && t.type)) !== 'Emoji');
  return out.length ? out : undefined;
}

export function timelineEmojis(emojiJson) {
  try { const arr = emojiJson ? JSON.parse(emojiJson) : null; return (Array.isArray(arr) && arr.length) ? arr : undefined; }
  catch { return undefined; }
}

// FEP-e232 object links (quotes / inline references). Inbound: keep the note's
// Link tags whose mediaType marks an AP object (the AS2-profiled ld+json, or
// activity+json as its equivalent) as JSON, so the C2S inbox read can serve
// them back and a client (Shaer) can render the quote/reference. Mirrors
// extractEmojiTags. Plain hyperlinks (text/html) and Mentions are dropped.
export function extractObjectLinkTags(tag) {
  const arr = Array.isArray(tag) ? tag : (tag ? [tag] : []);
  const links = arr.filter((t) => {
    if (!t || (Array.isArray(t.type) ? t.type[0] : t.type) !== 'Link') return false;
    if (typeof t.href !== 'string' || !t.href) return false;
    const mt = String(t.mediaType || '').toLowerCase();
    return (mt.startsWith('application/ld+json') && mt.includes('activitystreams'))
      || mt.startsWith('application/activity+json');
  });
  return links.length ? JSON.stringify(links) : null;
}
export function timelineObjectLinks(linkJson) {
  try { const arr = linkJson ? JSON.parse(linkJson) : null; return (Array.isArray(arr) && arr.length) ? arr : undefined; }
  catch { return undefined; }
}

// FEP-044f quote posts: a quote is usually NOT an FEP-e232 tag but an
// object-level property. FEP-044f §"how to recognise" lists them all:
// `quote` (the FEP property, a string or an embedded Link/object), and the
// de-facto `quoteUrl` (as:), `quoteUri` (fedibird), `_misskey_quote` (misskey).
// This returns the quoted object's URL from whichever is present.
export function extractQuoteUrl(note) {
  if (!note || typeof note !== 'object') return null;
  const q = note.quote ?? note.quoteUrl ?? note.quoteUri ?? note['_misskey_quote'];
  if (!q) return null;
  if (typeof q === 'string') return q || null;
  if (typeof q === 'object') return (typeof q.id === 'string' && q.id) || (typeof q.href === 'string' && q.href) || null;
  return null;
}

// The note's object-link tags for storage: real FEP-e232 Link tags PLUS any
// FEP-044f object-level quote, normalised to one FEP-e232-shaped Link (rel
// _misskey_quote) so the client's single object-link path renders them all.
// Deduped by href. Returns the JSON to store (or null if the note has neither).
export function extractLinkJson(note) {
  const links = [];
  const fromTag = extractObjectLinkTags(note && note.tag);
  if (fromTag) { try { links.push(...JSON.parse(fromTag)); } catch { /* ignore */ } }
  const qUrl = extractQuoteUrl(note);
  if (qUrl && !links.some((l) => l && l.href === qUrl)) {
    links.push({ type: 'Link', mediaType: 'application/activity+json', href: qUrl,
      rel: ['https://misskey-hub.net/ns#_misskey_quote'], name: qUrl });
  }
  return links.length ? JSON.stringify(links) : null;
}

// The URL of the quoted post, from either an object-level quote (FEP-044f) or a
// quote-rel FEP-e232 Link tag. Used to resolve the embedded quote card.
export function quoteHrefOf(note) {
  const direct = extractQuoteUrl(note);
  if (direct) return direct;
  const arr = Array.isArray(note && note.tag) ? note.tag : (note && note.tag ? [note.tag] : []);
  for (const t of arr) {
    if (!t || (Array.isArray(t.type) ? t.type[0] : t.type) !== 'Link' || typeof t.href !== 'string') continue;
    const rel = Array.isArray(t.rel) ? t.rel : (t.rel ? [t.rel] : []);
    if (rel.some((r) => /quote/i.test(String(r)))) return t.href;
  }
  return null;
}

// Turn the stored quote snapshot back into the object the C2S inbox read serves
// as `shaer:quote`, so the client can render the embedded quote card.
export function timelineQuote(quoteJson) {
  try { const q = quoteJson ? JSON.parse(quoteJson) : null; return (q && typeof q === 'object') ? q : undefined; }
  catch { return undefined; }
}

// Store the author's display-name emoji map (from actorInfo().emojis) on a
// timeline row, so the byline can render a ":shortcode:" name. No-op when the
// name has no custom emoji (the common case).
function storeAuthorEmoji(id, slug, ai) {
  if (!ai || !ai.emojis || !Object.keys(ai.emojis).length) return;
  try { db.prepare('UPDATE ap_timeline SET author_emoji_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(ai.emojis), id, slug); } catch { /* ignore */ }
}

// A display-name emoji map (actorInfo().emojis) → JSON to store, or null.
function emojiJsonOf(map) { return (map && Object.keys(map).length) ? JSON.stringify(map) : null; }

// ── Cirkel = posts from the accounts you auto-boost ("feature an artist") ──
let _abCount, _cirkelPosts, _cirkelMembers;
export function autoBoostCount(slug) {
  try { if (!_abCount) _abCount = db.prepare('SELECT COUNT(*) AS n FROM ap_following WHERE slug = ? AND auto_boost = 1'); return _abCount.get(slug).n; } catch { return 0; }
}
export function getCirkelPosts(slug, limit, offset) {
  try {
    // Cirkel = posts from featured (auto_boost) accounts + posts you boosted
    // (t.boosted), mixed by date. One row per note in ap_timeline → no duplicates.
    if (!_cirkelPosts) _cirkelPosts = db.prepare(`
      SELECT t.id, t.author_uri, t.author_name, t.author_handle, t.author_icon, t.author_url,
             t.content, t.url, t.published, t.media_json, t.nsfw, t.cw,
             (rb.target_uri IS NOT NULL) AS boosted
      FROM ap_timeline t
      LEFT JOIN ap_following f ON f.slug = t.slug AND f.actor_uri = t.author_uri
      -- Uit de tussentabel, niet uit t.boosted: die kolom is een afgeleide. De
      -- UNIQUE(site_slug, target_uri, kind) garandeert hoogstens één match, dus
      -- deze join kan geen rijen verdubbelen.
      LEFT JOIN ap_my_reactions rb ON rb.site_slug = t.slug AND rb.target_uri = t.id AND rb.kind = 'boost'
      WHERE t.slug = ? AND (f.auto_boost = 1 OR rb.target_uri IS NOT NULL)
      ORDER BY COALESCE(t.published, t.created_at) DESC, t.rowid DESC
      LIMIT ? OFFSET ?`);
    return _cirkelPosts.all(slug, limit || 60, offset || 0);
  } catch { return []; }
}
export function getCirkelMembers(slug) {
  try { if (!_cirkelMembers) _cirkelMembers = db.prepare('SELECT name, url, icon FROM ap_following WHERE slug = ? AND auto_boost = 1 ORDER BY name'); return _cirkelMembers.all(slug); } catch { return []; }
}
// AFGELEIDE, GEEN BRON (shaer-9e9). De waarheid over "heb ik hierop gereageerd"
// staat in ap_my_reactions; deze vlaggen worden daaruit bijgehouden door
// setReaction en door niets anders. Roep ze niet los aan -- dan schrijf je de
// helft, en dat is precies hoe shaer:liked maandenlang false bleef (04aca12).
//
// ap_timeline.boosted verdient zijn bestaan wel: hij staat in de WHERE van de
// Cirkel-feed (getCirkelPosts) en in boostedCount, dus hij is een index en geen
// kopie. ap_timeline.liked wordt nergens als verzameling bevraagd en kan weg
// zodra fase 2 lang genoeg goed staat; hij is nu nog het vangnet waarmee
// terugdraaien een code-revert blijft in plaats van dataherstel.
let _markBoost, _unmarkBoost, _boostedCount;
export function markBoosted(slug, noteId) {
  try { if (!_markBoost) _markBoost = db.prepare('UPDATE ap_timeline SET boosted = 1 WHERE slug = ? AND id = ?'); _markBoost.run(slug, noteId); } catch { /* ignore */ }
}
export function unmarkBoosted(slug, noteId) {
  try { if (!_unmarkBoost) _unmarkBoost = db.prepare('UPDATE ap_timeline SET boosted = 0 WHERE slug = ? AND id = ?'); _unmarkBoost.run(slug, noteId); } catch { /* ignore */ }
}
let _markLike, _unmarkLike;
export function markLiked(slug, noteId) {
  try { if (!_markLike) _markLike = db.prepare('UPDATE ap_timeline SET liked = 1 WHERE slug = ? AND id = ?'); _markLike.run(slug, noteId); } catch { /* ignore */ }
}
export function unmarkLiked(slug, noteId) {
  try { if (!_unmarkLike) _unmarkLike = db.prepare('UPDATE ap_timeline SET liked = 0 WHERE slug = ? AND id = ?'); _unmarkLike.run(slug, noteId); } catch { /* ignore */ }
}
/**
 * Zet een reactie van JOU op een object. Dit hoort het enige schrijfpad te zijn
 * (shaer-9e9): de tussentabel ap_my_reactions is de waarheid, de vlaggen op
 * ap_timeline zijn de afgeleide. Zolang markLiked en broers los aanroepbaar
 * blijven kan een aanroeper ze vergeten, en dat is niet hypothetisch -- precies
 * dat leverde de shaer:liked-bug op (04aca12).
 *
 * `opts.note` is de opgeloste remote note bij een boost. Die is niet optioneel
 * uit netheid: een boost moet de post je tijdlijn IN trekken als je de auteur
 * niet volgt, anders heeft de vlag geen rij om op te landen en verschijnt de
 * boost nergens -- ook niet in de Cirkel.
 *
 * `opts.flagUri` bestaat omdat de twee bronnen vandaag verschillend gesleuteld
 * worden: de tussentabel op de URI die de client stuurde, de vlag op de
 * opgeloste object-URI. Meestal zijn die gelijk, maar niet gegarandeerd. Deze
 * naad houdt fase 1 gedragsbehoudend; het samentrekken van die twee sleutels is
 * werk voor fase 2, mét datamigratie.
 */
// Reactie-migratie (shaer-9e9). Draait bij boot, EEN keer per bump, net als
// selfHealTimeline. Bewust automatisch: klonkt-update tilt een hele vloot in een
// stap naar nieuwe code, en een handmatig script per instance wordt vergeten --
// terwijl het falen stil is (een reactie die niemand meer ziet geeft geen fout).
// v2 haalt de derde bron erbij: ap_interactions.acted_* (shaer-ipb). Een bump
// laat alle stappen opnieuw lopen, en dat mag -- ze zijn alle drie idempotent.
const REACTIONS_MIGRATION_VERSION = 2;

/**
 * Brengt alle reacties naar de tussentabel, onder de canonieke object-URI.
 *
 * Twee stappen, en ze zijn allebei nodig:
 *
 *  1. HERSLEUTELEN. De oude interact-route bewaarde de URI waarmee je binnenkwam
 *     en de bookmarklet geeft window.location.href door, dus de permalink. Sinds
 *     canonicalReactionUri wordt er op de object-URI gezocht, waardoor die rijen
 *     wees zouden zijn. De created_at reist mee: bij hersleutelen weten we
 *     wanneer je reageerde, bij aanvullen niet.
 *  2. AANVULLEN vanuit de afgeleide kolommen. Alles wat op oude code via de
 *     Krant is gegeven staat alleen daar; zonder deze stap toont het als
 *     niet-gereageerd en klikt een gebruiker opnieuw -- met een tweede Like de
 *     fediverse in als gevolg.
 *
 * Idempotent. Geeft terug wat er gebeurd is, zodat het script het kan tonen.
 */
export function migrateReactions(opts = {}) {
  const uit = { hersleuteld: 0, aangevuld: 0, reacties: 0, overgeslagen: false };
  try {
    if (!opts.force) {
      const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('reactions_migration_version');
      const cur = r ? (parseInt(r.value, 10) || 0) : 0;
      if (cur >= REACTIONS_MIGRATION_VERSION) { uit.overgeslagen = true; return uit; }
    }
  } catch { return uit; }   // geen app_settings → deze database is te oud om aan te raken

  // Een rij die NIET op een tijdlijn-id staat maar wel op een tijdlijn-url.
  const wees = `
    FROM ap_my_reactions r JOIN ap_timeline t ON t.slug = r.site_slug AND t.url = r.target_uri
     WHERE NOT EXISTS (SELECT 1 FROM ap_timeline t2 WHERE t2.slug = r.site_slug AND t2.id = r.target_uri)`;
  const scheef = (kind, kolom) => `
    FROM ap_timeline t
     WHERE t.${kolom} = 1
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = t.slug AND r.target_uri = t.id AND r.kind = '${kind}')`;
  // 3. De derde bron: wat JIJ deed met een reactie onder je eigen post. De slug
  //    hangt hier niet aan de rij maar aan de post; vandaar de twee joins. Een
  //    rij zonder object_uri kan nooit een reactie dragen (fedi-react eist hem),
  //    dus die uitsluiting verliest per constructie niets.
  const acted = (kind, kolom) => `
    FROM ap_interactions i
     JOIN posts p ON p.id = i.post_id
     JOIN sites s ON s.id = p.site_id
     WHERE i.${kolom} = 1 AND IFNULL(i.object_uri, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = s.slug AND r.target_uri = i.object_uri AND r.kind = '${kind}')`;

  if (opts.dryRun) {
    const tel = (sql) => { try { return db.prepare(`SELECT COUNT(*) AS n ${sql}`).get().n; } catch { return 0; } };
    uit.hersleuteld = tel(wees);
    uit.aangevuld = tel(scheef('like', 'liked')) + tel(scheef('boost', 'boosted'));
    uit.reacties = tel(acted('like', 'acted_like')) + tel(acted('boost', 'acted_boost'));
    return uit;
  }

  try {
    db.transaction(() => {
      // 1. Hersleutelen: eerst de canonieke variant erbij, dan de permalink weg.
      //    In die volgorde, zodat een onderbreking hooguit een dubbele rij
      //    oplevert en nooit een verdwenen reactie.
      uit.hersleuteld = db.prepare(`
        INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind, created_at)
        SELECT r.site_slug, t.id, r.kind, r.created_at ${wees}`).run().changes;
      db.prepare(`DELETE FROM ap_my_reactions WHERE rowid IN (SELECT r.rowid ${wees})`).run();

      // 2. Aanvullen vanuit de kolommen.
      for (const [kind, kolom] of [['like', 'liked'], ['boost', 'boosted']]) {
        uit.aangevuld += db.prepare(`
          INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind)
          SELECT t.slug, t.id, '${kind}' ${scheef(kind, kolom)}`).run().changes;
      }

      // 3. En vanuit acted_* op de reacties onder je eigen posts.
      for (const [kind, kolom] of [['like', 'acted_like'], ['boost', 'acted_boost']]) {
        uit.reacties += db.prepare(`
          INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind)
          SELECT s.slug, i.object_uri, '${kind}' ${acted(kind, kolom)}`).run().changes;
      }
    })();
    if (uit.hersleuteld || uit.aangevuld || uit.reacties) {
      console.log(`[AP] reaction migration v${REACTIONS_MIGRATION_VERSION}: ${uit.hersleuteld} re-keyed, ${uit.aangevuld} backfilled, ${uit.reacties} from comments`);
    }
    if (!opts.force) {
      db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)')
        .run('reactions_migration_version', String(REACTIONS_MIGRATION_VERSION));
    }
  } catch (e) {
    // Niet fataal: de kolommen staan er nog, dus de oude waarheid is niet weg.
    // Een volgende boot probeert het opnieuw, want de versie is niet gezet.
    console.warn('[AP] reaction migration failed:', e.message);
  }
  return uit;
}

/**
 * Van wat de client stuurde naar de canonieke sleutel voor een reactie.
 *
 * Een post heeft twee URI's: zijn AP-object-id (.../ap/notes/<uuid>) en zijn
 * leesbare permalink (.../effortlesseffect). De Krant en het C2S-pad spreken de
 * eerste, de interact-pagina de tweede. Werden reacties onder allebei opgeslagen,
 * dan bestond dezelfde like twee keer -- en erger: een like uit de Krant was op
 * de interact-pagina onzichtbaar, want daar werd op de permalink gezocht.
 *
 * Dit was de naad die fase 1 bewust open liet ("samentrekken is werk voor fase
 * 2"). Robin liep er meteen tegenaan: een geboost en geliket bericht toonde geen
 * highlight. Vandaar hier, en niet later.
 *
 * De object-URI wint, want dat is waar ap_timeline op sleutelt en waar de
 * backfill op is gebaseerd. Kennen we de post niet, dan blijft de invoer staan:
 * een reactie op iets buiten je tijdlijn moet gewoon werken.
 */
export function canonicalReactionUri(slug, uri) {
  if (!slug || !uri) return uri;
  try {
    if (db.prepare('SELECT 1 FROM ap_timeline WHERE slug = ? AND id = ?').get(slug, uri)) return uri;
    const row = db.prepare('SELECT id FROM ap_timeline WHERE slug = ? AND url = ? LIMIT 1').get(slug, uri);
    return (row && row.id) || uri;
  } catch { return uri; }
}

/**
 * Wat heb IK met dit object gedaan? Leest de tussentabel, de bron van waarheid
 * sinds shaer-9e9 fase 2. Vervangt getMyReactions en getTimelineReaction, die
 * dezelfde vraag beantwoordden uit twee verschillende bronnen.
 */
export function getReaction(slug, uri) {
  try {
    const key = canonicalReactionUri(slug, uri);
    const rows = (slug && key)
      ? db.prepare('SELECT kind FROM ap_my_reactions WHERE site_slug = ? AND target_uri = ?').all(slug, key)
      : [];
    return { liked: rows.some((r) => r.kind === 'like'), boosted: rows.some((r) => r.kind === 'boost') };
  } catch { return { liked: false, boosted: false }; }
}

/**
 * Dezelfde vraag voor een hele pagina in EEN query. De C2S-tijdlijn zet
 * shaer:liked op elke post; per rij vragen zou dat een N+1 maken, en dan had je
 * een consistentiebug geruild voor een traagheidsbug.
 */
export function getReactionsFor(slug, uris) {
  const out = new Map();
  const list = [...new Set((uris || []).filter(Boolean))].slice(0, 500);
  if (!slug || !list.length) return out;
  try {
    const rows = db.prepare(
      `SELECT target_uri, kind FROM ap_my_reactions
        WHERE site_slug = ? AND target_uri IN (${list.map(() => '?').join(',')})`,
    ).all(slug, ...list);
    for (const r of rows) {
      const cur = out.get(r.target_uri) || { liked: false, boosted: false };
      if (r.kind === 'like') cur.liked = true;
      if (r.kind === 'boost') cur.boosted = true;
      out.set(r.target_uri, cur);
    }
  } catch { /* leeg = niets gereageerd, en dat is een veilige uitkomst */ }
  return out;
}

export function setReaction(slug, uri, kind, on, opts = {}) {
  if (!slug || !uri || (kind !== 'like' && kind !== 'boost')) return;
  // Ook hier, en niet alleen bij sendInteraction. Deze functie schrijft ALLEEN de
  // lokale vlag; het versturen gebeurt elders. Zonder deze poort zou je op een
  // verhuisd account een like zien staan die nooit de deur uit is gegaan, en dat
  // is de halve toestand die erger is dan een duidelijke weigering.
  try {
    const s = db.prepare('SELECT moved_to FROM sites WHERE slug = ?').get(slug);
    if (movedLock(s).locked) { console.warn('[AP] reactie geweigerd, account verhuisd:', slug, kind); return; }
  } catch { /* geen sites-tabel = geen verhuizing */ }
  // EEN sleutel voor beide bronnen. opts.flagUri is de opgeloste object-URI van
  // de aanroeper (het C2S-pad kent die uit resolveRemoteNote en dat is
  // betrouwbaarder dan onze cache); anders leiden we hem af. Vroeger kreeg de
  // tussentabel de URI die de client stuurde en de vlag de opgeloste -- dat
  // maakte dezelfde like onvindbaar vanaf de andere pagina.
  const flagUri = opts.flagUri || canonicalReactionUri(slug, uri);
  setMyReaction(slug, flagUri, kind, !!on);
  if (kind === 'boost') {
    if (!on) unmarkBoosted(slug, flagUri);
    else if (opts.note) upsertBoostedNote(slug, opts.note);
    else markBoosted(slug, flagUri);
  } else if (on) markLiked(slug, flagUri);
  else unmarkLiked(slug, flagUri);
}

export function getTimelineReaction(slug, noteId) {
  try { const r = db.prepare('SELECT liked, boosted FROM ap_timeline WHERE slug = ? AND id = ?').get(slug, noteId); return { liked: !!(r && r.liked), boosted: !!(r && r.boosted) }; } catch { return { liked: false, boosted: false }; }
}
// Boost a REMOTE post that may not be in your timeline (you don't follow the author):
// store it in ap_timeline (INSERT OR IGNORE → no dup for followed posts) so it shows in
// the Cirkel with a Boost badge, then flag it boosted.
export function upsertBoostedNote(slug, note) {
  if (!slug || !note || !note.object_uri) return;
  const id = note.object_uri;
  // Prefer the full typed media (incl. video/mp4 — a Loops boost is video-only and
  // rendered a bare text tile); fall back to the image-only list for older callers.
  const media = (note.media && note.media !== '[]')
    ? note.media
    : JSON.stringify((note.images || []).map((u) => ({ url: u, type: 'image/jpeg' })));
  try {
    const r = tlStmts().ins.run(id, slug, note.actor_uri || '', note.actor_name || '', note.actor_handle || '',
      note.actor_icon || '', note.actor_url || '', note.content || '', note.url || null,
      new Date().toISOString(), media, note.sensitive ? 1 : 0, note.cw || null);
    if (!r.changes) {
      // Row already cached (INSERT OR IGNORE) → refresh it with the freshly
      // resolved note. Without this a row cached without its cover (or with
      // stale content) stayed stale forever — even boosting again didn't heal it.
      // Keep the CACHED media when the resolve yielded none: an empty re-resolve
      // used to clobber a good media_json (the followed copy had the video, the
      // boost wiped it to []).
      db.prepare(`UPDATE ap_timeline SET content = ?, media_json = CASE WHEN ? = '[]' THEN media_json ELSE ? END,
                  nsfw = ?, cw = ?, url = COALESCE(?, url) WHERE slug = ? AND id = ?`)
        .run(note.content || '', media, media, note.sensitive ? 1 : 0, note.cw || null, note.url || null, slug, id);
    }
  } catch { /* ignore */ }
  markBoosted(slug, id);
}
export function boostedCount(slug) {
  // Geboost EN in je tijdlijn, zoals voorheen: de tussentabel kan ook een boost
  // bevatten van iets dat er (nog) niet in staat.
  try {
    if (!_boostedCount) _boostedCount = db.prepare(`SELECT COUNT(*) AS n FROM ap_my_reactions r
      JOIN ap_timeline t ON t.slug = r.site_slug AND t.id = r.target_uri
      WHERE r.site_slug = ? AND r.kind = 'boost'`);
    return _boostedCount.get(slug).n;
  } catch { return 0; }
}

// Resolve a Klonkt/AP actor URL from a site root: a Klonkt site's root 302s to
// /ap/users/<slug> (content negotiation; Location may be relative). Used by
// followActor for bare-domain follows.
// NB: the old auto-migration of legacy Cirkels (circle_links -> AP follows) was
// REMOVED on 2026-06-26 — it auto-sent Follows on boot, which violates "the code
// never throws anything into the fediverse automatically" (would surprise-Follow
// for some operators at scale). The dead circle_links table stays as harmless dead
// data; an operator restores an old cirkel by re-following in /following (their click).
async function resolveApActor(siteUrl) {
  try {
    const r = await fetch(siteUrl, { headers: { Accept: 'application/activity+json' }, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) { const loc = r.headers.get('location'); if (loc) return new URL(loc, siteUrl).href; }
    if (r.ok) return siteUrl;
  } catch { /* unreachable */ }
  return null;
}

// ── Self-heal: re-sync the fediverse cache (ap_timeline) after a DRASTIC update ──
// Runs ONCE per SELFHEAL_VERSION bump — NOT on every boot. Re-fetches each cached
// note and refreshes content + media (recovers covers/edits that were delivered
// during a flux window, e.g. a fleet-wide update), and drops notes that are gone
// (404/410). Bump SELFHEAL_VERSION only on a release that warrants a re-sync.
const SELFHEAL_VERSION = 22; // v22: summary is pas een waarschuwing MET sensitive, en een artikel houdt zijn titel
async function fetchNoteAP(url) {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/activity+json' } });
    if (r.status === 404 || r.status === 410) return 404;
    if (r.ok) return await r.json();
  } catch { /* unreachable */ }
  return null;
}
function mediaFromNote(note) {
  const atts = (Array.isArray(note.attachment) ? note.attachment : []).map((a) => {
    const m = { url: safeUrl(a && a.url), type: (a && a.mediaType) || '' };
    // A federated video may carry its poster as an AS2 icon (shaer-zowq).
    const iconUrl = a && a.icon && safeUrl(typeof a.icon === 'string' ? a.icon : a.icon.url);
    if (iconUrl && /^video\//i.test(m.type)) m.poster = iconUrl;
    return m;
  }).filter((m) => m.url);
  if (!atts.some((m) => !m.type || /image/i.test(m.type)) && note.image) {
    const im = Array.isArray(note.image) ? note.image[0] : note.image;
    const iu = safeUrl(typeof im === 'string' ? im : (im && im.url));
    if (iu) atts.push({ url: iu, type: (im && im.mediaType) || 'image/jpeg' });
  }
  return JSON.stringify(atts);
}

// FEP-044f, emit side. The mirror of extractQuoteUrl (ingest): when one of our
// own posts quotes a fediverse object, say so in the shapes the network really
// reads. `quote` is the FEP property; quoteUrl / _misskey_quote are the de-facto
// ones Mastodon and Misskey look at, and the FEP-e232 `Link` in `tag` is the
// third form. All three point at the same object, which is what every reader
// expects. The quoted author goes in `cc`, because being quoted without being
// told is exactly the rudeness this FEP is trying to design away.
export function applyQuoteProps(note, quoteUri, quoteActor) {
  if (!note || typeof quoteUri !== 'string' || !/^https?:\/\//i.test(quoteUri)) return note;
  note.quote = quoteUri;
  note.quoteUrl = quoteUri;
  note['_misskey_quote'] = quoteUri;
  note.tag = [...(note.tag || []), {
    type: 'Link',
    mediaType: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    href: quoteUri,
    rel: ['https://misskey-hub.net/ns#_misskey_quote'],
    name: quoteUri,
  }];
  if (typeof quoteActor === 'string' && /^https?:\/\//i.test(quoteActor)) {
    note.cc = [...new Set([...(note.cc || []), quoteActor])];
  }
  return note;
}

// The first external (non-fediverse) link in a note, resolved to the same card
// shape as a quote: THUMBNAIL ONLY, never the provider's iframe. An arbitrary
// third-party frame inside a kid-safe app is a hole you cannot close again, so
// the embed carries an image and a title and nothing executable.
// Returns the JSON to store, or null when there is nothing worth showing.
export async function resolveExternalEmbed(html) {
  const first = firstExternalUrl(html);
  if (!first) return null;
  const io = EmbedResolver.liveIO({
    safeFetch,
    detectProvider: (u) => AudioEmbedService.detectProvider(u),
    fetchActor,
    actorInfo,
  });
  const card = await EmbedResolver.resolveEmbed(first, io).catch(() => null);
  // 'ap' is handled by the quote path; a bare 'link' is not worth a card.
  if (!card || card.kind === 'ap' || card.kind === 'link') return null;
  const thumb = (card.media || []).find((m) => m && m.url);
  if (!thumb && !card.title) return null;
  // Title, provider and author name come from a third party. Store them as
  // PLAIN TEXT (tags stripped, length-capped), so no renderer downstream has to
  // be the one that remembers to escape. A card is a card, not an essay.
  const plain = (v) => (v ? HtmlSanitizerService.toPlainText(String(v)).trim().slice(0, 200) : null);
  return JSON.stringify({
    url: card.url,
    kind: card.kind,                       // 'provider' | 'oembed'
    provider: plain(card.provider),
    title: plain(card.title),
    author: card.author ? { ...card.author, name: plain(card.author.name), handle: plain(card.author.handle) } : null,
    media: thumb ? [thumb] : [],           // thumbnail only, no html/iframe
  });
}

/**
 * Does our own post link to a fediverse object? Returns { uri, actor } when the
 * first external link resolves to a quotable AP object, else null. Runs once at
 * publish time; the answer is stored on the post.
 */
export async function resolveOwnQuote(html) {
  const first = firstExternalUrl(html);
  if (!first) return null;
  const io = EmbedResolver.liveIO({ safeFetch, detectProvider: () => null, fetchActor, actorInfo });
  const card = await EmbedResolver.resolveEmbed(first, io).catch(() => null);
  if (!card || card.kind !== 'ap' || !card.id) return null;
  return { uri: card.id, actor: card.attributedTo || null };
}

/**
 * De composer-preview (shaer-k3f): één URL langs exact dezelfde pijplijn als
 * publiceren, zodat wat de preview toont ook is wat de post krijgt. Twee
 * uitkomsten, hoogstens een gevuld: een AP-object wordt een quote-snapshot,
 * een externe link probeert een kaart. Beide als JSON-string, dezelfde vorm
 * als de kolommen -- de route serveert ze door timelineQuote/timelineEmbed en
 * de gate, net als de tijdlijn.
 */
export async function previewCard(url) {
  if (!/^https?:\/\//i.test(String(url || ''))) return {};
  const html = `<a href="${String(url).replace(/"/g, '&quot;')}">x</a>`;
  const q = await resolveOwnQuote(html);
  if (q && q.uri) {
    const quoteJson = await resolveQuoteByUri(q.uri).catch(() => null);
    if (quoteJson) return { quoteJson };
  } else {
    const embedJson = await resolveExternalEmbed(html).catch(() => null);
    if (embedJson) return { embedJson };
  }
  return {};
}

/** The first http(s) link in sanitized note HTML that is not a mention/hashtag. */
export function firstExternalUrl(html) {
  if (!html || typeof html !== 'string') return null;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0];
    if (/\b(mention|hashtag|u-url)\b/i.test(tag) && /mention|hashtag/i.test(tag)) continue;
    const href = m[1];
    if (/^https?:\/\//i.test(href)) return href;
  }
  return null;
}

/** The stored external-embed card, for the C2S read. */
// ── Standaardvormen in plaats van eigen dialect (shaer-nmw) ───────
//
// Robins waarschuwing: geen Klonkt/Shaer-dialect schrijven waar AS2 of een FEP
// het al regelt. Vier eigen properties hadden een standaard naast zich staan,
// en deze helpers zijn die standaard -- een definitie per vorm, zodat de tien
// plekken die ze emitten niet elk hun eigen variant krijgen.
//
// De oude shaer:-velden blijven er voorlopig NAAST staan. Een app in het veld
// leest ze nog, en een leeg scherm is een duurdere fout dan een dubbel veld;
// ze gaan eruit als de clients om zijn (tweede helft van shaer-nmw).

/** FEP-9098 Emoji-tags uit een {shortcode: url}-kaart. */
function emojiTagsFromMap(emojis) {
  const uit = Object.entries(emojis || {})
    .filter(([naam, url]) => naam && url)
    .map(([naam, url]) => ({ type: 'Emoji', name: naam, icon: { type: 'Image', url } }));
  return uit.length ? uit : undefined;
}

/**
 * Een actor als INGESLOTEN OBJECT voor `attributedTo` / `actor`.
 *
 * AS2 staat toe dat attributedTo een object is in plaats van een URI, en dan
 * heeft ELKE client er wat aan -- niet alleen de onze, die er shaer:author
 * naast kreeg. `preferredUsername` is de lokale naam; een lezer leidt de handle
 * af uit die naam plus de host van de id, precies zoals wij serverkant ook
 * doen. Weten we niets van de persoon, dan blijft het de kale URI: een leeg
 * object zou beweren dat we hem kennen.
 */
export function actorObject(uri, info) {
  if (!uri) return undefined;
  const iets = info && (info.name || info.handle || info.icon || info.url);
  if (!iets) return uri;
  const o = { id: uri, type: 'Person' };
  if (info.name) o.name = info.name;
  const lokaal = String(info.handle || '').replace(/^@/, '').split('@')[0];
  if (lokaal) o.preferredUsername = lokaal;
  if (info.icon) o.icon = { type: 'Image', url: info.icon };
  if (info.url) o.url = info.url;
  const tags = emojiTagsFromMap(info.emojis);
  if (tags) o.tag = tags;
  return o;
}

/**
 * De linkkaart als AS2 `preview` (core: "identifies an entity that provides a
 * preview of this object"). Een Page met url, name en image IS een kaart; daar
 * hoefde shaer:embed nooit voor te bestaan.
 *
 * Wat WEL van ons blijft is de spelerpagina: dat die alleen meegaat als de
 * guardians de poort openden is FEP-633c-gedrag en heeft geen AS2-tegenhanger.
 */
export function previewObject(embedJson, { playback = false } = {}) {
  const e = timelineEmbed(embedJson, { playback });
  if (!e) return undefined;
  const thumb = (e.media || []).find((m) => m && m.url);
  const p = { type: 'Page', url: e.url };
  if (e.title) p.name = e.title;
  if (thumb) p.image = { type: 'Image', url: thumb.url };
  if (e.author && (e.author.name || e.author.handle)) {
    p.attributedTo = { type: 'Person', name: e.author.name || e.author.handle };
  }
  if (e['shaer:playerUrl']) p['shaer:playerUrl'] = e['shaer:playerUrl'];
  if (e['shaer:playable']) p['shaer:playable'] = e['shaer:playable'];
  return p;
}

/**
 * De geciteerde post als OBJECT in `quote` (FEP-044f staat toe dat quote het
 * object zelf is, niet alleen een URI). De opgeslagen momentopname wordt hier
 * een echte Note, met de auteur als ingesloten actor -- dus geen tweede eigen
 * property voor iets dat de FEP al kan.
 */
export function quoteObject(quoteJson) {
  const q = timelineQuote(quoteJson);
  if (!q) return undefined;
  const note = { type: 'Note', id: q.url, url: q.url };
  if (q.content) note.content = q.content;
  if (q.published) note.published = q.published;
  if (q.author) {
    note.attributedTo = actorObject(q.author.url || q.url, {
      name: q.author.name, handle: q.author.handle, icon: q.author.icon,
    });
  }
  const media = (q.media || []).filter((m) => m && m.url)
    .map((m) => ({ type: 'Document', mediaType: m.type || undefined, url: m.url }));
  if (media.length) note.attachment = media;
  const tags = emojiTagsFromMap(q.emojis);
  if (tags) note.tag = tags;
  return note;
}

export function timelineEmbed(embedJson, { playback = false } = {}) {
  try {
    const e = embedJson ? JSON.parse(embedJson) : null;
    if (!e || typeof e !== 'object' || !e.url) return undefined;
    // The player URL is served ONLY when the playback gate is open (FEP-633c
    // 5.6). Deciding it here keeps the provider knowledge in one place: the
    // client never needs a list of hosts, it just plays what it is handed.
    // Privacy-enhanced variants only: nocookie for YouTube, the instance's own
    // player for PeerTube. Without one the card stays a thumbnail.
    const player = playback ? playerUrlFor(e.url) : null;
    if (player) return { ...e, 'shaer:playerUrl': player };
    // The gate is shut and there IS something behind it. Saying so costs
    // nothing (the card already shows a video thumbnail) and saves the child
    // from tapping a card that will never answer: the app can explain instead
    // of doing nothing. It stays a statement of fact, never a way in.
    return playerUrlFor(e.url) ? { ...e, 'shaer:playable': true } : e;
  } catch { return undefined; }
}

/** The embeddable player for a URL, or null when we will not frame it. */
export function playerUrlFor(url) {
  if (typeof url !== 'string') return null;
  let p = null;
  try { p = AudioEmbedService.detectProvider(url); } catch { p = null; }
  if (p && p.provider === 'youtube' && p.id) return `https://www.youtube-nocookie.com/embed/${p.id}?rel=0&modestbranding=1&playsinline=1`;
  if (p && p.provider === 'vimeo' && p.id) return `https://player.vimeo.com/video/${p.id}`;
  // PeerTube is decentralised, so it is matched by its watch-URL shape rather
  // than a provider list. Host chars are validated before it is inlined.
  const pt = url.match(/^https?:\/\/([\w.-]+(?::\d+)?)\/(?:w|videos\/watch)\/([\w-]{6,})/i);
  if (pt) return `https://${pt[1]}/videos/embed/${pt[2]}`;
  return null;
}

// FEP-044f embedded quote card: resolve the quoted post to a compact, sanitised
// snapshot { url, author{name,handle,icon}, content, published, media } so the
// client can render it as a nested card instead of a bare link. Best-effort and
// SSRF-safe (apGetJson): returns null on any failure, and the client falls back
// to the object-link chip. The content goes through the same sanitiser as every
// other note, so the kid-safe guarantees hold.
async function resolveQuote(note) {
  const url = quoteHrefOf(note);
  if (!url) return null;
  return resolveQuoteByUri(url);
}

/** Hetzelfde snapshot, maar vanaf een kale URI: eigen posts en de
 *  composer-preview (shaer-k3f) kennen alleen de link, niet de tag-vorm. */
async function resolveQuoteByUri(url) {
  const q = await apGetJson(url);
  if (!q || typeof q !== 'object') return null;
  const authorUri = typeof q.attributedTo === 'string' ? q.attributedTo
    : (q.attributedTo && typeof q.attributedTo.id === 'string' ? q.attributedTo.id : null);
  const ai = authorUri ? actorInfo(await fetchActor(authorUri), authorUri) : null;
  // The quoted post's own FEP-9098 emojis, so :shortcode: renders in the card.
  const emojis = {};
  try {
    for (const e of JSON.parse(extractEmojiTags(q.tag) || '[]')) {
      const u = e.icon && (e.icon.url || (Array.isArray(e.icon) && e.icon[0] && e.icon[0].url));
      if (typeof e.name === 'string' && u) emojis[e.name] = u;
    }
  } catch { /* ignore */ }
  let media = []; try { media = JSON.parse(mediaFromNote(q)); } catch { /* ignore */ }
  const snapshot = {
    url: safeUrl(q.url || q.id || url) || url,
    author: ai ? { name: ai.name, handle: ai.handle, icon: ai.icon } : null,
    content: HtmlSanitizerService.sanitize(q.content || ''),
    published: q.published || null,
    media,
    emojis: Object.keys(emojis).length ? emojis : undefined,
  };
  return JSON.stringify(snapshot);
}

/**
 * The card under a post: a fediverse quote (FEP-044f) when the note has one,
 * otherwise an external link preview. Both render as the SAME card, so only one
 * of the two is ever stored. Returns {column, json} or null.
 *
 * Both halves reach out over the network, which is why every caller runs this
 * out of band: an inbox answer must never wait on a third party.
 */
async function resolveCard(o) {
  if (quoteHrefOf(o)) {
    const qj = await resolveQuote(o);
    return qj ? { column: 'quote_json', json: qj } : null;
  }
  const ej = await resolveExternalEmbed(o && o.content);
  return ej ? { column: 'embed_json', json: ej } : null;
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

async function apGetJson(url) {
  try {
    const r = await safeFetch(url, { headers: { Accept: 'application/activity+json' } });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 3_000_000) return null;
    return await r.json();
  } catch { return null; }
}
// AP-native catch-up: pull an actor's standard `outbox` collection and merge their recent
// top-level posts into the timeline for `slug`. Push (Create delivery) cannot backfill
// history-from-before-you-followed or a delivery that was missed while you were down;
// reading the outbox is the spec-conform way to catch up. PULL ONLY — sends nothing.
export async function backfillFromOutbox(slug, actorUri, limit = 20) {
  try {
    if (!slug || !actorUri) return 0;
    const actor = await fetchActor(actorUri);
    if (!actor || !actor.outbox) return 0;
    // Signed as the follower (30-7): the serving side recognises an accepted
    // friend and hands the friends-only history along; an anonymous GET only
    // ever sees the public set. A server that ignores the signature behaves
    // exactly as before.
    let page = await signedGetJson(slug, typeof actor.outbox === 'string' ? actor.outbox : actor.outbox.id);
    let items = (page && (page.orderedItems || page.items)) || [];
    if (!items.length && page && page.first) {
      page = await signedGetJson(slug, typeof page.first === 'string' ? page.first : page.first.id);
      items = (page && (page.orderedItems || page.items)) || [];
    }
    if (!Array.isArray(items) || !items.length) return 0;
    const ai = actorInfo(actor, actorUri);
    let added = 0;
    for (const it of items.slice(0, limit)) {
      // Each item is usually a Create wrapping a Note, or sometimes the Note itself.
      const o = (it && typeof it.object === 'object' && it.object) ? it.object : it;
      if (!o || !o.id) continue;
      if (o.type && o.type !== 'Note' && o.type !== 'Article' && o.type !== 'Question') continue; // skip boosts/other
      if (o.inReplyTo) continue;                                          // top-level only
      const auth = actorUriOf(o.attributedTo);
      if (auth && auth !== actorUri) continue;                            // their OWN posts only
      const html = HtmlSanitizerService.sanitize(o.content || '');
      const poll = parsePoll(o); // a Question (poll) → carry its options/counts on backfill too
      try {
        const r = tlStmts().ins.run(o.id, slug, actorUri, ai.name, ai.handle, ai.icon, ai.url, html, o.url || null, o.published || null, mediaFromNote(o), o.sensitive ? 1 : 0, contentWarning(o));
        if (r && r.changes > 0) added++;
        // FEP-9098: keep custom-emoji tags from backfilled posts too.
        { const ej = extractEmojiTags(o.tag); if (ej) { try { db.prepare('UPDATE ap_timeline SET emoji_json = ? WHERE id = ? AND slug = ?').run(ej, o.id, slug); } catch { /* ignore */ } } }
        storeAuthorEmoji(o.id, slug, ai);   // custom-emoji display name for the byline
        // FEP-e232 + FEP-044f: keep object-link/quote tags from backfilled posts too.
        { const lj = extractLinkJson(o); if (lj) { try { db.prepare('UPDATE ap_timeline SET link_json = ? WHERE id = ? AND slug = ?').run(lj, o.id, slug); } catch { /* ignore */ } } }
        // FEP-044f: resolve the embedded quote card for backfilled posts too.
        if (quoteHrefOf(o)) { const qj = await resolveQuote(o); if (qj) { try { db.prepare('UPDATE ap_timeline SET quote_json = ? WHERE id = ? AND slug = ?').run(qj, o.id, slug); } catch { /* ignore */ } } }
        // Set poll_json if this is a poll and we don't already have it (COALESCE preserves a vote).
        if (poll) { try { db.prepare('UPDATE ap_timeline SET poll_json = COALESCE(poll_json, ?) WHERE id = ? AND slug = ?').run(JSON.stringify(poll), o.id, slug); } catch { /* ignore */ } }
      } catch { /* ignore */ }
    }
    if (added) console.log('[AP] outbox backfill', actorUri, '→', slug, '+' + added);
    return added;
  } catch { return 0; }
}

// ── Remote thread crawl (fill the gaps in a local post's conversation) ────────────
// Most replies reach us by delivery, but replies-to-replies that live on other servers and
// aren't addressed to us are missed. This pulls the AS2 `replies` collections of the replies
// we DO have, caching any newly-found ones in ap_interactions.
//
// Matches Mastodon's behaviour: ONE level per crawl (like its FetchRepliesService), not a deep
// recursive walk. Deeper levels fill in incrementally across crawls — once a fetched reply is
// cached it becomes a seed itself, so its own replies are pulled on a later view (Mastodon's
// per-status cascade). Bounded + polite (serial), PULL only, and stale-while-revalidate: it
// never runs in a page request — the view renders from cache; a stale post kicks off a
// background refresh for the NEXT view.
const THREAD_TTL_MS = 15 * 60 * 1000;   // don't re-crawl a post more than ~4×/hour
const THREAD_MAX_DEPTH = 1;             // one hop per crawl (like Mastodon); deeper fills in over crawls
const THREAD_MAX_FETCHES = 30;          // hard cap on remote GETs per crawl (be a good peer)
const _crawlingThreads = new Set();     // per-post in-flight lock (no stampede across views)

function threadCrawlTs(postId) {
  try { const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('thread_crawl:' + postId); return r ? (Number(r.value) || 0) : 0; }
  catch { return 0; }
}
function setThreadCrawlTs(postId, ts) {
  try { db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('thread_crawl:' + postId, String(ts)); }
  catch { /* ignore */ }
}

// Read a note's `replies` (string ref / Collection with `first` / paged CollectionPages) →
// child note URIs. Every remote GET goes through `budget` so the whole crawl stays capped.
async function collectReplyItems(repliesRef, maxPages, budget) {
  const uris = [];
  let node = typeof repliesRef === 'string' ? await budget.get(repliesRef) : repliesRef;
  if (node && node.first) node = typeof node.first === 'string' ? await budget.get(node.first) : node.first;
  let pages = 0;
  while (node && pages++ < maxPages) {
    for (const it of (node.items || node.orderedItems || [])) {
      const u = typeof it === 'string' ? it : (it && it.id);
      if (u && /^https?:\/\//i.test(u)) uris.push(u);
    }
    if (!node.next) break;
    node = typeof node.next === 'string' ? await budget.get(node.next) : node.next;
  }
  return uris;
}

async function crawlThread(postId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base) return;
  // Seed frontier = the remote reply note URIs we already have; also the dedup set.
  let known;
  try { known = new Set(db.prepare("SELECT object_uri FROM ap_interactions WHERE post_id = ? AND kind = 'reply' AND object_uri != ''").all(postId).map((r) => r.object_uri)); }
  catch { return; }
  const seeds = [...known].filter((u) => /^https?:\/\//i.test(u));
  if (!seeds.length) return; // nothing remote to expand
  // Owner-removed replies (tombstones) join the dedup set AFTER seeding, so the
  // crawler never re-adds them via thread-filling (they're gone from the seeds
  // already because rejectInteraction deleted their ap_interactions row).
  try { for (const r of db.prepare('SELECT object_uri FROM ap_rejected_objects WHERE post_id = ?').all(postId)) known.add(r.object_uri); }
  catch { /* table always exists after boot migration */ }

  let fetches = 0;
  const budget = { get: async (u) => { if (fetches >= THREAD_MAX_FETCHES) return null; fetches++; return apGetJson(u); } };
  const visited = new Set(); // notes whose replies collection we've already expanded
  let frontier = seeds.slice();
  let added = 0;

  for (let depth = 0; depth < THREAD_MAX_DEPTH && frontier.length && fetches < THREAD_MAX_FETCHES; depth++) {
    const nextFrontier = [];
    for (const noteUri of frontier) {
      if (visited.has(noteUri) || fetches >= THREAD_MAX_FETCHES) continue;
      visited.add(noteUri);
      const note = await budget.get(noteUri);
      if (!note || !note.replies) continue;
      const childUris = await collectReplyItems(note.replies, 2, budget);
      for (const cu of childUris) {
        if (known.has(cu) || fetches >= THREAD_MAX_FETCHES) continue;
        known.add(cu);
        const child = await budget.get(cu);
        if (!child || !child.id || (child.type !== 'Note' && child.type !== 'Article')) continue;
        if (isRejectedObject(child.id)) continue; // note id can differ from the collection URI (redirects)
        const actorUri = actorUriOf(child.attributedTo);
        if (!actorUri || isBlockedAny(actorUri)) continue; // skip blocked authors
        const actor = await budget.get(actorUri); // may be null if budget spent → fallback handle
        const ai = actorInfo(actor, actorUri);
        const html = HtmlSanitizerService.sanitize(child.content || '');
        // The child replies to `note` by construction (it's in note's replies collection).
        try { iStmts().ins.run('reply', postId, child.id, actorUri, ai.name, ai.handle, ai.url, ai.icon, html, child.published || null, note.id || noteUri, noteVisibility(child), extractEmojiTags(child.tag), emojiJsonOf(ai.emojis)); added++; } catch { /* ignore */ }
        nextFrontier.push(child.id); // expand this reply's own replies next depth
      }
    }
    frontier = nextFrontier;
  }
  if (added) console.log('[AP] thread crawl', postId, '+' + added, 'remote replies (' + fetches + ' fetches)');
}

// Stale-while-revalidate entry point: call from the post view. Renders nothing, blocks nothing —
// fires a background crawl only if this post hasn't been crawled within the TTL.
export function maybeCrawlThread(postId) {
  if (!postId || _crawlingThreads.has(postId)) return;
  if (Date.now() - threadCrawlTs(postId) < THREAD_TTL_MS) return;
  _crawlingThreads.add(postId);
  setThreadCrawlTs(postId, Date.now()); // optimistic mark so concurrent/next views don't re-fire
  crawlThread(postId).catch((e) => console.warn('[AP] thread crawl failed:', e && e.message)).finally(() => _crawlingThreads.delete(postId));
}

let _selfHealing = false;
export async function selfHealTimeline() {
  if (_selfHealing) return; _selfHealing = true;
  try {
    let cur = 0;
    try { const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('selfheal_version'); cur = r ? (parseInt(r.value, 10) || 0) : 0; } catch { return; }
    if (cur >= SELFHEAL_VERSION) return; // already healed for this version — skip on normal boots
    // v21: direct notes used to land in the timeline as if they were posts, so a
    // ward's 🛟 help request showed up in the guardian's Krant. The insert now
    // refuses them; drop the ones already cached. Scoped to the two kinds we can
    // still recognise afterwards (help request, wave) — a plain public mention
    // from someone you follow IS a timeline post and must stay.
    try {
      const r = db.prepare(`DELETE FROM ap_timeline WHERE EXISTS (
        SELECT 1 FROM ap_mentions m
         WHERE m.object_uri = ap_timeline.id AND m.slug = ap_timeline.slug
           AND (m.help_request = 1 OR m.wave = 1))`).run();
      if (r.changes) console.log(`[AP] self-heal v21: ${r.changes} direct note(s) removed from the timeline`);
    } catch { /* table may predate the columns */ }
    let rows = [];
    try { rows = db.prepare('SELECT id, slug, content, media_json, nsfw, cw, url, emoji_json, link_json, quote_json, author_uri, author_name, author_emoji_json, reblog_name, reblog_handle, reblog_emoji_json, embed_json FROM ap_timeline ORDER BY rowid DESC LIMIT 200').all(); } catch { /* no table */ }
    let healed = 0, failed = 0;
    for (const r of rows) {
      // Link previews first, and deliberately BEFORE the note re-fetch. A
      // preview is resolved from the content we already hold, so hanging it
      // behind a remote fetch meant one unreachable origin skipped the whole
      // row (`continue` below) and the card never appeared. It needs nothing
      // from the origin, so it must not depend on it.
      if (!r.quote_json && !r.embed_json) {
        try {
          const ej = await resolveExternalEmbed(r.content);
          if (ej) db.prepare('UPDATE ap_timeline SET embed_json = ? WHERE id = ?').run(ej, r.id);
        } catch { /* best-effort, never blocks the heal */ }
      }
      try {
        const note = await fetchNoteAP(r.id);
        if (note === 404) { db.prepare('DELETE FROM ap_timeline WHERE id = ?').run(r.id); healed++; continue; }
        if (!note || typeof note !== 'object') { failed++; continue; } // origin unreachable right now
        // Door DEZELFDE bouwer als de innamekant (v22). Hij bouwde de inhoud
        // hier zelf op, en daardoor miste een gerepareerde rij precies wat de
        // inname wel doet -- de titel van een artikel bijvoorbeeld. Een
        // zelfherstel dat een andere vorm oplevert dan de inname repareert naar
        // een derde toestand.
        const velden = timelineFields(note);
        const html = velden.html;
        const media = velden.atts.length ? JSON.stringify(velden.atts) : mediaFromNote(note);
        const nsfw = note.sensitive ? 1 : 0;   // re-sync NSFW/sensitive + CW onto already-cached posts
        const cw = contentWarning(note);
        const url = note.url || null;          // re-sync the human url (catches a remote slug rename)
        const emoji = extractEmojiTags(note.tag);   // FEP-9098: re-capture custom-emoji tags (v8)
        const link = extractLinkJson(note);   // FEP-e232 + FEP-044f: re-capture object-link/quote tags (v9)
        // FEP-044f: resolve the embedded quote card (v11). COALESCE-style: keep a
        // cached snapshot if the quoted post is momentarily unreachable now.
        const quote = quoteHrefOf(note) ? (await resolveQuote(note)) || r.quote_json || null : null;
        if ((html && html !== r.content) || media !== (r.media_json || '[]') || nsfw !== (r.nsfw || 0) || (cw || '') !== (r.cw || '') || (url && url !== r.url) || (emoji || '') !== (r.emoji_json || '') || (link || '') !== (r.link_json || '') || (quote || '') !== (r.quote_json || '')) {
          db.prepare('UPDATE ap_timeline SET content = ?, media_json = ?, nsfw = ?, cw = ?, url = COALESCE(?, url), emoji_json = ?, link_json = ?, quote_json = ? WHERE id = ?').run(html || r.content, media, nsfw, cw, url, emoji, link, quote, r.id);
          healed++;
        }
        // v13: a custom-emoji display name needs the author's emoji map. Fetch
        // the actor once, only for rows whose name has a shortcode and no map yet.
        if (/:[A-Za-z0-9_+-]+:/.test(r.author_name || '') && !r.author_emoji_json && r.author_uri) {
          const ai = actorInfo(await fetchActor(r.author_uri), r.author_uri);
          if (ai.emojis) { try { db.prepare('UPDATE ap_timeline SET author_emoji_json = ? WHERE id = ?').run(JSON.stringify(ai.emojis), r.id); } catch { /* ignore */ } }
        }
        // v14: same for the booster's display name ("X boosted"). The row stores
        // no booster URI, so resolve it from the handle via webfinger. Scoped to
        // this exact row (slug) since a note can be boosted by different people.
        if (/:[A-Za-z0-9_+-]+:/.test(r.reblog_name || '') && !r.reblog_emoji_json && r.reblog_handle) {
          const bUri = await webfingerResolve(r.reblog_handle);
          const em = bUri ? actorNameEmojis(await fetchActor(bUri)) : undefined;
          if (em) { try { db.prepare('UPDATE ap_timeline SET reblog_emoji_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(em), r.id, r.slug); } catch { /* ignore */ } }
        }
      } catch { failed++; /* per-note best-effort */ }
    }
    // Only mark this version DONE after a clean pass. Some origins are briefly
    // offline exactly when we heal (phone-hosted instances!): skipping them and
    // consuming the version would leave those rows stale forever. Instead retry
    // on the next boots, giving up after a few attempts (permanently-dead
    // origins answer 404/410 and are deleted above, so they don't loop).
    const setSetting = (k, v) => { try { db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(k, String(v)); } catch { /* ignore */ } };
    let attempts = 0;
    try { const a = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('selfheal_attempts'); attempts = a ? (parseInt(a.value, 10) || 0) : 0; } catch { /* ignore */ }
    if (failed === 0 || attempts >= 4) {
      setSetting('selfheal_version', SELFHEAL_VERSION);
      setSetting('selfheal_attempts', 0);
    } else {
      setSetting('selfheal_attempts', attempts + 1);
    }
    if (rows.length) console.log(`[AP] self-heal v${SELFHEAL_VERSION}: ${healed}/${rows.length} timeline notes${failed ? ` (${failed} unreachable — will retry next boot)` : ''}`);
  } catch { /* never block boot */ } finally { _selfHealing = false; }
}

// Follow a fediverse account by @handle (WebFinger → actor → signed Follow).
export async function followActor(site, handle, autoBoost = false, { approved = false } = {}) {
  const _mv = movedRefusal(site, 'follow'); if (_mv) return _mv;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  // DE POORT STAAT HIER, en niet alleen in de C2S-outbox (shaer-p729, Barts
  // melding 8-8: de volgverzoeken van Esmee kwamen nooit bij haar guardians
  // aan). Hij stond in `case 'Follow'` van de outbox -- dus alleen als je via
  // Shaer volgt. Volgde het kind vanuit Klonkts eigen webinterface, dan werd er
  // geen verzoek aangemaakt, ging er niets naar de guardians, en was er dus ook
  // niets om te beantwoorden. Precies dezelfde deur-naast-de-poort als bij de
  // antwoordpoort vanmiddag (shaer-r4c).
  //
  // Merk op wat het NIET was: niet dat een guardian elders het niet kon
  // beantwoorden. Die weg werkt en levert een Offer af bij de externe guardian.
  // Er kwam alleen nooit iets aan om af te leveren.
  //
  // `approved` is de enige doorlaat, voor performApprovedFollow: zonder dat zou
  // een goedgekeurd verzoek opnieuw op de poort stuiten en voor eeuwig wachten.

  // Accept any of: a profile/actor URL, an @user@host handle (WebFinger), or a
  // bare site domain (site.com) — for a single-actor site (Klonkt etc.) the root
  // resolves to its AP actor, so you can follow a site by just its domain.
  const s = String(handle || '').trim();
  let actorUrl;
  if (/^https?:\/\//i.test(s)) actorUrl = safeUrl(s) || null;
  else if (s.includes('@')) actorUrl = await webfingerResolve(s);
  else if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(s)) actorUrl = await resolveApActor('https://' + s.replace(/^\/+|\/+$/g, ''));
  else actorUrl = null;
  if (!actorUrl) return { error: 'not_found' };
  // NA het oplossen, want een kind volgt net zo goed met @naam@server of een
  // kaal domein. Zou de poort alleen naar de ruwe invoer kijken, dan is elke
  // handle een sluiproute -- en dat is precies de fout die we hier repareren,
  // een maat kleiner.
  if (!approved) {
    const held = await gateOutgoingFollow(site, actorUrl);
    if (held) return { held: true, id: held.id, status: held.status || 'pending' };
  }
  // SIGNED, as this actor: an authorized-fetch instance refuses an anonymous
  // GET of the actor doc, which made following from a boost silently fail
  // (Robins melding, 31-7). Signed, the other side sees who asks.
  const actor = await signedGetJson(site.slug, actorUrl);
  if (!actor || !actor.id || !actor.inbox) return { error: 'unreachable' };
  const ai = actorInfo(actor, actor.id);
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const followId = `${me}#follow-${Date.now()}-${rid()}`;
  fwStmts().ins.run(site.slug, actor.id, ai.handle, ai.name, ai.icon, ai.url, actor.inbox, followId, 'pending', autoBoost ? 1 : 0);
  const follow = { '@context': AP_CONTEXT, id: followId, type: 'Follow', actor: me, object: actor.id };
  // Deliver via the retry queue: a Follow that fails the first attempt (peer down,
  // timeout, transient 5xx) is retried with backoff instead of staying stuck on
  // 'pending' forever — the Accept can only come back once the Follow lands.
  await deliverWithRetry(site.slug, actor.inbox, follow, `${me}#main-key`, keys.private_pem);
  console.log('[AP] follow', site.slug, '→', actor.id);
  // Follow + feature in one step → backfill their recent posts into the Cirkel right away.
  if (autoBoost) backfillFromOutbox(site.slug, actor.id).catch(() => {});
  // A ward's guardians are TOLD about a new follow (Robins verzoek, 31-7):
  // a follow brings new content into the child's feed, and the village
  // should know the door opened. A direct note per guardian, best-effort;
  // FEP-633c 5.3 gates inbound follows, the outbound notice is Shaer policy
  // for now (bead: spec-vraag).
  try {
    const guardians = Guardianship.listGuardians(site.slug);
    if (guardians.length) {
      const meRef = actorId(base, site.slug);
      const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
      const label = esc(ai.name || ai.handle || actor.id);
      for (const g of guardians) {
        const note = {
          id: `${meRef}/follow-notice/${Date.now().toString(36)}${rid()}`,
          type: 'Note', attributedTo: meRef, to: [g.other_uri],
          tag: [{ type: 'Mention', href: g.other_uri }],
          content: `<p>👀 ${esc(site.title || site.slug)} is now following ${label}.</p>`,
        };
        deliverToActor(site, g.other_uri, { id: `${note.id}#create`, type: 'Create', actor: meRef, to: [g.other_uri], object: note })
          .catch(() => { /* retried by the queue */ });
      }
      console.log('[AP] follow notice →', guardians.length, 'guardian(s) of', site.slug);
    }
  } catch { /* geen guardians is geen fout */ }
  return { ok: true, name: ai.name, handle: ai.handle, actor: actor.id };
}

// Resolve a profile URL or @handle to a followable remote actor (for the
// authorize_interaction "Follow" flow). Returns display fields + inbox, or null
// when it isn't a reachable actor (e.g. the input was a post, not a profile).
export async function resolveRemoteActor(input) {
  const s = String(input || '').trim();
  const actorUrl = /^https?:\/\//i.test(s) ? (safeUrl(s) || null) : await webfingerResolve(s);
  if (!actorUrl) return null;
  const actor = await fetchActor(actorUrl).catch(() => null);
  if (!actor || !actor.id || !actor.inbox) return null;
  const ai = actorInfo(actor, actor.id);
  return { actor_uri: actor.id, actor_name: ai.name, actor_handle: ai.handle, actor_url: ai.url, actor_icon: ai.icon, inbox: actor.inbox };
}

export async function unfollowActor(site, actorUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const row = fwStmts().one.get(site.slug, actorUri);
  // Undo(Follow) MUST reference the original Follow's real id so the remote can correlate it
  // and drop the follow. The old `${me}#follow` fallback never matched anything → the unfollow
  // silently failed on the remote. With no stored follow id (legacy row), skip the network Undo
  // rather than send an unmatchable one. Deliver durably via the retry queue.
  if (row && row.inbox && row.follow_id) {
    const undo = { '@context': AP_CONTEXT, id: `${me}/undo/${Date.now()}-${rid()}`, type: 'Undo', actor: me, object: { id: row.follow_id, type: 'Follow', actor: me, object: actorUri } };
    deliverWithRetry(site.slug, row.inbox, undo, `${me}#main-key`, keys.private_pem);
  } else if (row && row.inbox) {
    console.warn('[AP] unfollow', site.slug, '→', actorUri, '— no stored follow id; removed locally only (legacy follow, remote may keep it)');
  }
  fwStmts().del.run(site.slug, actorUri);
  return { ok: true };
}

/**
 * FEP-7628 (DRAFT status — the shape is Mastodon's since 2019, but the FEP can
 * still change): an account our sites follow says it moved to a new home.
 *
 * Validity has two independent legs, and both must hold:
 *  1. The SIGNER is a party to the move: the old actor announcing its own move
 *     (push mode) or the new actor doing it (pull mode). A third party
 *     narrating someone else's move is refused — without this, any signed
 *     stranger could re-point our follows.
 *  2. The NEW actor claims the old identity in its `alsoKnownAs`. That is the
 *     cross-side proof: the mover controls both ends. Without it, whoever
 *     holds ONE end could hijack the other end's followers.
 *
 * Effect: every local site following the old actor unfollows it and follows
 * the new one, keeping its auto-boost choice. Deliberately NOT retargeted:
 * guardianship relations (FEP-633c) — a guardian is a security anchor, not a
 * feed subscription, and moving one is shaer-tge's gated decision, not a
 * side effect of an inbox event. We only log when a move touches one.
 *
 * Deps are injectable for tests (no network in node:test).
 */
export async function handleMoveInbox(act, { verifiedActor = null, fetchActorFn = null, followFn = null, unfollowFn = null } = {}) {
  const oldUri = typeof act.object === 'string' ? act.object : (act.object && act.object.id);
  const newUri = typeof act.target === 'string' ? act.target : (act.target && act.target.id);
  if (!oldUri || !newUri || oldUri === newUri) return 400;
  if (!verifiedActor || (verifiedActor !== oldUri && verifiedActor !== newUri)) {
    console.warn('[AP] Move refused: signer is not a party to the move', verifiedActor || '(unsigned)', oldUri, '→', newUri);
    return 401;
  }
  // Nobody here follows the old actor → nothing to move. This also makes
  // redelivery idempotent: after the first swap the rows are gone.
  let rows = [];
  try { rows = db.prepare('SELECT * FROM ap_following WHERE actor_uri = ?').all(oldUri); } catch { /* fresh init */ }
  if (!rows.length) return 202;
  // A blocked destination is declined outright: the old follow stays (it goes
  // stale on its own), and we will not open a door to a blocked house.
  if (isBlockedAny(newUri)) { console.log('[AP] Move dropped: target is blocked', newUri); return 202; }
  const target = await (fetchActorFn || fetchActor)(newUri);
  const aka = [].concat((target && target.alsoKnownAs) || [])
    .map((a) => (typeof a === 'string' ? a : (a && a.id))).filter(Boolean);
  if (!target || !target.id || !aka.includes(oldUri)) {
    console.warn('[AP] Move refused: target does not claim the old actor in alsoKnownAs', oldUri, '→', newUri);
    return 202; // decline to act; no 4xx, the sender may be a well-meaning retrying server
  }
  // EERST de guardianship, DAARNA pas de follows. Die volgorde is geen netheid
  // maar de hele werking, en hij is met bloed geschreven: bij Robins verhuizing
  // op 13-8 stond het andersom en het log liet precies zien wat er dan gebeurt.
  //
  //   [AP] outgoing Follow beta → .../robo (gated, awaiting guardians)
  //
  // Beta is zelf een ward. Zijn UITGAANDE follow naar de verhuisde guardian werd
  // gepoort (§5.3), want op dat moment stond het nieuwe adres nog niet in zijn
  // guardian-lijst: de code hieronder had de relatie nog niet bijgewerkt. En de
  // INKOMENDE kant heeft hetzelfde probleem, want de ward gate't een Follow van
  // een onbekende. Dus beide richtingen bleven hangen op goedkeuring die niemand
  // hoefde te geven, omdat het om een guardian ging die er al was.
  //
  // Met de relatie eerst is de verhuisde actor al een erkende guardian als de
  // follows langskomen, en gaat de auto-acceptatie gewoon door.
  //
  // Een Move is een Move: de guardian is dezelfde guardian, het kind is hetzelfde
  // kind, alleen het adres is nieuw. Zelfde bescherming als de re-follow: alleen
  // na een geverifieerde Move, en niet naar een geblokkeerde bestemming (daar
  // zijn we hierboven al uitgestapt). De twee harde randen van shaer-tge staan
  // hier LOS van: weigeren te verhuizen naar een instance die shaer:guardians
  // niet kan dragen is een controle aan de UITGAANDE kant, en het
  // terugkeren-zonder-set is een alsoKnownAs-kwestie.
  try {
    const g = db.prepare('SELECT slug, role FROM ap_guardianships WHERE other_uri = ? AND status = ?').all(oldUri, 'accepted');
    if (g.length) {
      const r = db.prepare('UPDATE ap_guardianships SET other_uri = ? WHERE other_uri = ? AND status = ?').run(newUri, oldUri, 'accepted');
      console.log('[AP] guardianship moved:', oldUri, '→', newUri, `(${r.changes}x)`, g.map((x) => `${x.role}:${x.slug}`).join(', '));
    }
  } catch (e) { console.warn('[AP] guardianship move failed:', e && e.message); }

  for (const row of rows) {
    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(row.slug);
    if (!site) continue;
    try {
      await (unfollowFn || unfollowActor)(site, oldUri);
      const already = fwStmts().one.get(row.slug, newUri);
      if (!already) await (followFn || followActor)(site, newUri, !!row.auto_boost);
      console.log('[AP] follow moved', row.slug, ':', oldUri, '→', newUri);
    } catch (e) {
      console.warn('[AP] move re-follow failed for', row.slug, e && e.message);
    }
  }
  return 202;
}

/**
 * Slice 2 van shaer-0j2 (FEP-7628, DRAFT): de UITGAANDE helft — deze Klonkt
 * is het oude huis en kondigt het vertrek aan. Twee eisen voordat er iets
 * de deur uit gaat:
 *  1. Geen guardians: een warded account verhuizen zonder de guardianship
 *     te hertargeten zou het vangnet van het kind stil breken; dat is
 *     shaer-tge's gated beslissing, dus tot die er is weigert een bewaakt
 *     account de verhuizing.
 *  2. De NIEUWE actor claimt ons in alsoKnownAs — dezelfde back-reference
 *     die elke ontvangende server (onze eigen slice 1 incluis) eist. Zonder
 *     die claim is de Move overal dood bij aankomst.
 * De Move gaat duurzaam naar elke volger-inbox; hun servers doen de
 * re-follow. `moved_to` wordt hier vastgelegd; het SERVEREN ervan op de
 * actor (en het beleid van de oude site) is slice 3.
 * Deps injecteerbaar voor tests (geen netwerk in node:test).
 */
export async function moveAccount(site, targetRaw, { fetchActorFn = null, deliverFn = null } = {}) {
  // Al verhuisd? Dan eerst het slot eraf (moved_to leegmaken). Anders stapel je
  // wegwijzers op elkaar en weet niemand meer waar de keten eindigt.
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  if (movedLock(site).locked) return { error: 'already_moved', movedTo: movedLock(site).movedTo };
  try {
    // Was een harde weigering voor elk bewaakt account (shaer-tge); sinds 8-8
    // een GATE met dezelfde standaard: de automatiek weigert voor een ward,
    // maar de guardians kunnen shaer:accountMove expliciet openzetten -- en
    // expliciet dichtzetten geldt dan ook voor een account dat net geen ward
    // meer is, net als bij de embeds.
    const isWard = Guardianship.listGuardians(site.slug).length > 0;
    if (!Guardianship.wardGateAllowed(site.gate_account_move, isWard)) {
      console.warn('[AP] move refused: gated (shaer-tge):', site.slug, '→', String(targetRaw || ''));
      return { error: 'guarded_account' };
    }
  } catch { /* geen guardianship-tabellen = geen guardians */ }
  const s = String(targetRaw || '').trim();
  let targetUri = null;
  if (/^https?:\/\//i.test(s)) targetUri = safeUrl(s);
  else if (s.includes('@')) targetUri = await webfingerResolve(s);
  if (!targetUri) return { error: 'not_found' };
  const me = actorId(base, site.slug);
  if (targetUri === me) return { error: 'self' };
  const target = await (fetchActorFn ? fetchActorFn(targetUri) : signedGetJson(site.slug, targetUri));
  if (!target || !target.id || !target.inbox) return { error: 'unreachable' };
  const aka = [].concat(target.alsoKnownAs || [])
    .map((a) => (typeof a === 'string' ? a : (a && a.id))).filter(Boolean);
  if (!aka.includes(me)) return { error: 'no_backreference' };
  db.prepare('UPDATE sites SET moved_to = ? WHERE slug = ?').run(target.id, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const move = {
    '@context': AP_CONTEXT,
    id: `${me}#move-${Date.now()}-${rid()}`,
    type: 'Move',
    actor: me,
    object: me,
    target: target.id,
    to: [`${me}/followers`],
  };
  // FEP-7628: after setting movedTo, notify the followers with an Update of
  // the actor, so their servers hold the signpost even if the Move itself is
  // lost. Built from the FRESH row: `site` still carries the pre-move values.
  const movedSite = db.prepare('SELECT * FROM sites WHERE slug = ?').get(site.slug) || { ...site, moved_to: target.id };
  const update = {
    '@context': AP_CONTEXT,
    id: `${me}#update-${Date.now()}-${rid()}`,
    type: 'Update', actor: me, to: [PUBLIC], cc: [`${me}/followers`],
    object: buildActor(base, movedSite),
    published: new Date().toISOString(),
  };
  const inboxes = [...new Set(fStmts().list.all(site.slug).map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const send = deliverFn || deliverWithRetry;
  for (const inbox of inboxes) {
    await send(site.slug, inbox, update, `${me}#main-key`, keys.private_pem);
    await send(site.slug, inbox, move, `${me}#main-key`, keys.private_pem);
  }
  console.log('[AP] MOVE announced:', site.slug, '→', target.id, 'to', inboxes.length, 'inbox(es)');
  return { ok: true, target: target.id, inboxes: inboxes.length };
}

// FEP-633c §5.3 note (authorized fetch): true when `actorUri` is a committed
/**
 * Who is reading this outbox, and what may they see (30-7)?
 *  - 'blocked': a verified caller this instance blocks. They get an EMPTY
 *    collection, not even the public set (Robins eis): a block is a closed
 *    door, and a signed fetch is the caller knocking with their name on it.
 *  - 'friend': the owner (bearer) or a verified accepted follower or
 *    guardian: the fan-only history rides along.
 *  - 'public': everyone else: the public set.
 */
export function outboxAudience(slug, { bearerSlug = null, verifiedActor = null } = {}) {
  if (bearerSlug && bearerSlug === slug) return 'friend';
  if (!verifiedActor) return 'public';
  if (isBlockedAny(verifiedActor)) return 'blocked';
  // FEP-1580, Source Instance: wie ondertekend vraagt namens de actor waar wij
  // NAARTOE verhuisd zijn, moet behandeld worden alsof wij het zelf vragen.
  // Anders kan de nieuwe instantie alleen het publieke deel ophalen en verhuist
  // je fan-only geschiedenis niet mee.
  if (isMoveTarget(slug, verifiedActor)) return 'friend';
  try {
    if (db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(slug, verifiedActor)) return 'friend';
  } catch { /* table absent on fresh init */ }
  if (isWardGuardian(slug, verifiedActor)) return 'friend';
  return 'public';
}

/**
 * FEP-1580, de hele autorisatie van de bronkant in één predicaat.
 *
 * De spec zegt: behandel een verzoek dat namens de DOEL-actor getekend is alsof
 * de BRON-actor het deed, voor zichtbaarheid en toegang. Wij hangen dat aan
 * `moved_to`, en dat mag omdat moveAccount() `no_backreference` weigert: het
 * veld komt er alleen te staan als de doel-actor ons al in `alsoKnownAs` had.
 * Dus staat er iets, dan heeft iemand met beheer op BEIDE kanten dat gewild.
 * Een typefout kan hier niet binnenkomen, want die haalt de move zelf niet.
 *
 * Dat dit veilig is leunt op de keyId-binding in verifyRequest (shaer-xd8i):
 * zonder die controle kon een actor tekenen met de sleutel van een buurman op
 * dezelfde host, en dan is "wie tekende dit" te zacht om je hele geschiedenis
 * aan af te geven.
 */
export function isMoveTarget(slug, actorUri) {
  if (!slug || !actorUri) return false;
  try {
    const row = db.prepare('SELECT moved_to FROM sites WHERE slug = ?').get(slug);
    return !!(row && row.moved_to && row.moved_to === actorUri);
  } catch { return false; }
}

// guardian of the local ward `wardSlug` — so a signed GET from it may read the
// ward's non-public history without the guardian appearing as a follower.
export function isWardGuardian(wardSlug, actorUri) {
  try { return !!Guardianship.getRelation(wardSlug, 'ward', actorUri); } catch { return false; }
}

// FEP-633c §5.3: the guardians approved a gated follow of their ward. Send the
// Accept to the follower and record them, so delivery (incl. followers-only)
// begins. `pending` is a row from ap_pending_follows.
/**
 * FEP-633c §5.3, the direction that was never gated (bead shaer-p729).
 *
 * A ward's OWN follow waited for nobody: it went straight out and the guardians
 * got a note afterwards (1a2f206). That is informing, not gating — the door is
 * already open when the message lands. Now it waits, with two exceptions that
 * are not favours but the same decision already taken:
 *
 *   - the target is one of the ward's own guardians. Following the adult who
 *     watches over you is not a question anyone needs to answer.
 *   - the target already follows the ward THROUGH THE GATE. A guardian
 *     approved that person by name; asking again about the same person only
 *     teaches everyone to stop reading the question.
 *
 * Returns the held request, or null when the follow may go out now.
 * Deliberately not a boolean: a held follow must be distinguishable from a sent
 * one all the way up to the app, which is the lesson the error path already
 * learned (Robins melding, 31-7).
 */
export async function gateOutgoingFollow(site, targetUri) {
  const slug = site && site.slug;
  if (!slug || !targetUri) return null;
  const guardians = Guardianship.listGuardians(slug).map((g) => g.other_uri);
  if (!guardians.length) return null;                                   // not a ward: nothing to gate
  // shaer:following (shaer-p729) — its own gate, apart from shaer:follows,
  // which governs the OTHER direction. §5.3 fixes the inbound one on: a Follow
  // aimed at a ward MUST pass the guardians. About this direction the FEP says
  // nothing, so it is ours to set and ours to let go of, and the guardians can
  // relax it for a child who has grown into it. Undecided means gated for a
  // ward, the same automatiek as the rest of the family.
  const gateRow = db.prepare('SELECT gate_following FROM sites WHERE slug = ?').get(slug);
  if (Guardianship.wardGateAllowed(gateRow && gateRow.gate_following, true)) return null;
  if (guardians.includes(targetUri)) return null;                       // your own guardian
  if (Guardianship.outgoing.isMutual(slug, targetUri)) return null;     // already vetted by name

  const seen = Guardianship.outgoing.findFor(slug, targetUri);
  if (seen && seen.status === 'approved') return null;                  // the guardians said yes already
  if (seen && (seen.status === 'pending' || seen.status === 'denied')) return seen;

  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const wardActor = actorId(base, slug);
  const target = await fetchActor(targetUri).catch(() => null);
  const ti = actorInfo(target, targetUri);
  const id = `${wardActor}#outfollow-${Date.now()}-${rid()}`;
  const held = Guardianship.outgoing.recordPending(slug, {
    id, target: targetUri,
    inbox: target && ((target.endpoints && target.endpoints.sharedInbox) || target.inbox),
    name: ti.name, handle: ti.handle, icon: ti.icon,
  });

  // Same routing as the inbound gate: a guardian on this instance gets a push
  // and reads /guardian; one elsewhere gets an Offer delivered so its own
  // server holds a copy to answer from.
  const wardKeys = getOrCreateKeys(slug);
  const followObj = { id, type: 'Follow', actor: wardActor, object: targetUri };
  for (const g of guardians) {
    try { Guardianship.availability.recordRequest(slug, g, id, Date.now()); } catch { /* never load-bearing */ }
  }
  for (const g of guardians) {
    const gslug = g.startsWith(`${base}/`) ? slugFromActorUrl(g) : null;
    const isLocal = gslug && db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(gslug);
    if (isLocal) {
      const L = pushLang(gslug);
      // De andere richting, en dus andere woorden: hier vraagt het kind of het
      // iemand mag volgen. Met dezelfde tekst als hierboven kon een guardian
      // op zijn telefoon niet zien wie er nu eigenlijk om wie vroeg.
      pushEvent(gslug, { type: 'guardian', title: i18nT(L, 'push.n_guard_folout_t'), body: i18nT(L, 'push.n_guard_folout_b', { who: ti.name || ti.handle || i18nT(L, 'notif.someone'), ward: slug }), url: `${pushPrefix(gslug)}/guardian` });
    } else {
      fetchActor(g).then((ga) => {
        const inbox = ga && ((ga.endpoints && ga.endpoints.sharedInbox) || ga.inbox);
        if (!inbox) return;
        // Zou DIT antwoord het besluit afmaken (shaer-8vt)? Bij twee guardians is de
        // drempel 1, dus de EERSTE ja beslist -- en dat is precies wat de
        // beantwoorder niet kon weten.
        const beslissend = Guardianship.gated.isDecisive(0, Guardianship.follows.followThreshold(guardians.length));
        const offer = { '@context': AP_CONTEXT, id: `${wardActor}#outfollowoffer-${Date.now()}-${rid()}`, type: 'Offer', actor: wardActor, to: [g], object: followObj, 'shaer:followApproval': true, 'shaer:direction': 'outgoing', 'shaer:decisive': beslissend };
        deliverWithRetry(slug, inbox, offer, `${wardActor}#main-key`, wardKeys.private_pem).catch(() => {});
      }).catch(() => {});
    }
  }
  console.log('[AP] outgoing Follow', slug, '→', targetUri, '(gated, awaiting guardians)');
  return held || { id, ward_slug: slug, target_uri: targetUri, status: 'pending' };
}

/**
 * The guardians said yes: send the ward's Follow for real (§5.3, shaer-p729).
 *
 * The row stays behind as `approved` rather than being deleted. It is the
 * record that these guardians vetted this target, so an unfollow-and-refollow
 * later does not put the same question in front of them again.
 */
export async function performApprovedFollow(pending) {
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(pending.ward_slug);
  if (!site) return { error: 'no_such_ward' };
  const r = await followActor(site, pending.target_uri, false, { approved: true });
  if (r && r.error) return { error: r.error };
  console.log('[AP] outgoing Follow approved', pending.ward_slug, '→', pending.target_uri);
  return { ok: true };
}

export async function acceptGatedFollow(pending) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const slug = pending.ward_slug;
  const me = actorId(base, slug);
  const keys = getOrCreateKeys(slug);
  fStmts().ins.run(slug, pending.follower_uri, pending.follower_inbox, pending.follower_shared_inbox, pending.follower_name, pending.follower_handle, pending.follower_icon);
  // This follower came through the §5.3 gate: a guardian said yes to this
  // person by name. That is precisely what lets the ward follow them back later
  // without asking the same guardians the same question twice (shaer-p729).
  db.prepare('UPDATE ap_followers SET gate_approved = 1 WHERE slug = ? AND actor_uri = ?').run(slug, pending.follower_uri);
  const original = pending.activity_json ? JSON.parse(pending.activity_json) : { type: 'Follow', actor: pending.follower_uri, object: me };
  const accept = { '@context': AP_CONTEXT, id: `${me}#accept-${Date.now()}-${rid()}`, type: 'Accept', actor: me, object: original };
  await deliverWithRetry(slug, pending.follower_inbox, accept, `${me}#main-key`, keys.private_pem);
  const filled = pending.follower_shared_inbox &&
    db.prepare('SELECT 1 FROM ap_followers WHERE slug = ? AND shared_inbox = ? AND actor_uri != ? LIMIT 1').get(slug, pending.follower_shared_inbox, pending.follower_uri);
  if (!filled) backfillNewFollower(base, slug, pending.follower_shared_inbox || pending.follower_inbox).catch(() => {});
  console.log('[AP] gated Follow accepted', pending.follower_uri, '→ ward', slug);
  return { ok: true };
}

// The guardians denied the follow: send a Reject so the follower's server clears
// its pending state, then the caller drops the record.
export async function rejectGatedFollow(pending) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const slug = pending.ward_slug;
  const me = actorId(base, slug);
  const keys = getOrCreateKeys(slug);
  const original = pending.activity_json ? JSON.parse(pending.activity_json) : { type: 'Follow', actor: pending.follower_uri, object: me };
  const reject = { '@context': AP_CONTEXT, id: `${me}#reject-${Date.now()}-${rid()}`, type: 'Reject', actor: me, object: original };
  if (pending.follower_inbox) await deliverWithRetry(slug, pending.follower_inbox, reject, `${me}#main-key`, keys.private_pem).catch(() => {});
  console.log('[AP] gated Follow rejected', pending.follower_uri, '→ ward', slug);
  return { ok: true };
}

// ── Cross-instance follow-approval (FEP-633c §5.3, modelled on the guardian
//    offer). Inbound: an Offer(Follow) forwarded by a ward to a guardian (leg
//    2), or a guardian's Accept/Reject coming back to the ward (leg 4). ──────
async function handleFollowApprovalInbox(act, slugParam) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const type = Array.isArray(act.type) ? act.type[0] : act.type;
  const actorUri = typeof act.actor === 'string' ? act.actor : (act.actor && act.actor.id);

  // Leg 2: I am a guardian; the object is the Follow to approve. The Offer is
  // signed by the ward, so act.actor is the ward.
  if (type === 'Offer') {
    const fo = (act.object && typeof act.object === 'object') ? act.object : null;
    const foType = fo && (Array.isArray(fo.type) ? fo.type[0] : fo.type);
    if (!fo || foType !== 'Follow') return false;
    const followId = fo.id;
    const follower = typeof fo.actor === 'string' ? fo.actor : (fo.actor && fo.actor.id);
    const wardUri = actorUri;
    if (!followId || !follower || !wardUri) return false;
    const recips = (Array.isArray(act.to) ? act.to : (act.to ? [act.to] : [])).filter((x) => typeof x === 'string');
    if (slugParam) recips.push(actorId(base, slugParam));
    let stored = false;
    for (const r of new Set(recips)) {
      const gslug = slugFromActorUrl(r);
      if (!gslug) continue;
      if (!Guardianship.getRelation(gslug, 'guardian', wardUri)) continue;   // must actually guard this ward
      const wardDoc = await fetchActor(wardUri).catch(() => null);
      const fai = actorInfo(await fetchActor(follower).catch(() => null), follower);
      // De RICHTING bewaren (shaer-jdb). shaer:direction wordt sinds de uitgaande
      // gate meegestuurd maar werd nergens gelezen, dus een uitgaande belandde
      // hier als "deze ward wil deze ward volgen" met het doel weggegooid.
      // Terugval voor oudere afzenders: is de volger de ward zelf, dan is het
      // uitgaand -- dat volgt uit de vorm en hoeft niet geloofd te worden.
      const uitgaand = act['shaer:direction'] === 'outgoing' || follower === wardUri;
      const doel = uitgaand ? (typeof fo.object === 'string' ? fo.object : (fo.object && fo.object.id)) : null;
      const dai = uitgaand ? actorInfo(await fetchActor(doel).catch(() => null), doel) : null;
      Guardianship.follows.recordReview(gslug, {
        id: followId, wardUri, wardInbox: wardDoc && wardDoc.inbox,
        follower, followerHandle: fai.handle, followerIcon: fai.icon, followJson: JSON.stringify(fo),
        direction: uitgaand ? 'outgoing' : 'incoming',
        target: doel || null, targetHandle: dai ? dai.handle : null,
      });
      const L = pushLang(gslug);
      // `uitgaand` staat hier al, drie regels hoger, en werd voor de melding
      // weer weggegooid: elke richting kreeg dezelfde tekst, geleend van
      // offer_for_ward. Op de telefoon las een volgverzoek dus als een
      // adoptie-aanvraag, en beide richtingen als elkaar.
      const wardNaam = (wardDoc && (wardDoc.preferredUsername || wardDoc.name)) || slugFromActorUrl(wardUri) || wardUri;
      const anderNaam = uitgaand
        ? ((dai && (dai.name || dai.handle)) || i18nT(L, 'notif.someone'))
        : (fai.name || fai.handle || i18nT(L, 'notif.someone'));
      pushEvent(gslug, {
        type: 'guardian',
        title: i18nT(L, uitgaand ? 'push.n_guard_folout_t' : 'push.n_guard_folin_t'),
        body: i18nT(L, uitgaand ? 'push.n_guard_folout_b' : 'push.n_guard_folin_b', { who: anderNaam, ward: wardNaam }),
        url: `${pushPrefix(gslug)}/guardian`,
      });
      stored = true;
    }
    return stored;
  }

  // Leg 4: I am the ward; a guardian decided. object is the Follow (id).
  const fo = act.object;
  const followId = typeof fo === 'string' ? fo : (fo && fo.id);
  if (!followId) return false;
  const pending = Guardianship.follows.getPending(followId);
  if (!pending) return false;
  const allGuardians = Guardianship.listGuardians(pending.ward_slug).map((g) => g.other_uri);
  if (!allGuardians.includes(actorUri)) return false;   // only a real guardian of this ward decides
  const decision = type === 'Reject' ? 'reject' : 'approve';
  // §3.5: the quorum runs over the AVAILABLE set. The voter itself was
  // restored by the one-answer rule when its activity arrived, so answering
  // is exactly what counts a guardian back in.
  const guardians = Guardianship.availability.availableSet(pending.ward_slug, allGuardians, Date.now());
  const r = Guardianship.follows.decide(followId, actorUri, decision, guardians);
  try {
    if (r.outcome === 'approved') { await acceptGatedFollow(r.follow); Guardianship.follows.remove(followId); }
    else if (r.outcome === 'rejected') { await rejectGatedFollow(r.follow); Guardianship.follows.remove(followId); }
  } catch { /* delivery is retried */ }
  return true;
}

// Leg 3: a guardian in /guardian decides on a forwarded follow; send the
// Accept/Reject back to the ward's inbox (signed by the guardian).
export async function sendFollowDecision(guardianSite, review, decision) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = actorId(base, guardianSite.slug);
  const keys = getOrCreateKeys(guardianSite.slug);
  const fo = review.follow_json ? JSON.parse(review.follow_json) : { id: review.id, type: 'Follow', actor: review.follower_uri, object: review.ward_uri };
  const activity = { '@context': AP_CONTEXT, id: `${me}#followdec-${Date.now()}-${rid()}`, type: decision === 'reject' ? 'Reject' : 'Accept', actor: me, to: [review.ward_uri], object: fo, 'shaer:followApproval': true };
  if (review.ward_inbox) await deliverWithRetry(guardianSite.slug, review.ward_inbox, activity, `${me}#main-key`, keys.private_pem);
  return { ok: true };
}

// Send a Like or Announce (boost) on a remote note FROM this site.
export async function sendInteraction(site, kind, targetNoteId, authorUri) {
  const _mv = movedRefusal(site, `interaction:${kind}`); if (_mv) return _mv;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !targetNoteId) return { error: 'config' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  // 'unboost' = Undo(Announce): retracts a boost so followers' servers remove the
  // reblog (matched on actor+object — no record of the original Announce needed).
  const fanout = (kind === 'boost' || kind === 'unboost'); // also goes to our followers
  const followersCol = `${me}/followers`;
  // Address the original author in cc so their server (Mastodon, WordPress/ActivityPub, …)
  // attributes the boost to their post and notifies them — without this, a shared-inbox
  // receiver has nothing to route the Announce to. Non-fragment activity ids + a `published`
  // stamp keep us aligned with what Mastodon emits.
  const audience = authorUri ? [followersCol, authorUri] : [followersCol];
  let act;
  if (kind === 'unboost' || kind === 'unlike') {
    // Undo(Announce) retracts a boost; Undo(Like) un-favourites (matched on actor+object,
    // no record of the original activity needed — Mastodon honours both).
    const inner = kind === 'unboost' ? 'Announce' : 'Like';
    act = {
      '@context': AP_CONTEXT,
      id: `${me}/undo/${Date.now()}-${rid()}`, type: 'Undo', actor: me,
      object: { id: `${me}/${inner.toLowerCase()}/${Date.now()}-${rid()}`, type: inner, actor: me, object: targetNoteId },
    };
    if (kind === 'unboost') { act.to = [PUBLIC]; act.cc = audience; }
  } else {
    const type = kind === 'boost' ? 'Announce' : 'Like';
    act = {
      '@context': AP_CONTEXT,
      id: `${me}/${type.toLowerCase()}/${Date.now()}-${rid()}`,
      type, actor: me, object: targetNoteId,
    };
    if (type === 'Announce') { act.published = new Date().toISOString(); act.to = [PUBLIC]; act.cc = audience; }
  }
  const inboxes = new Set();
  // Author first, via their PERSONAL inbox (not the shared one) so a multi-user receiver
  // routes the Announce/Like to the right post unambiguously.
  if (authorUri) { const a = await fetchActor(authorUri).catch(() => null); if (a) inboxes.add(a.inbox || (a.endpoints && a.endpoints.sharedInbox)); }
  if (fanout) { for (const f of fStmts().list.all(site.slug)) inboxes.add(f.shared_inbox || f.inbox); }
  // Queue each delivery (immediate attempt + backoff retries on failure via ap_delivery)
  // instead of a single fire-and-forget POST, so a transient hiccup at the receiver doesn't
  // silently lose the boost — same durability a new post (deliverCreate) already gets.
  let queued = 0;
  for (const inbox of [...inboxes].filter(Boolean)) { deliverWithRetry(site.slug, inbox, act, `${me}#main-key`, keys.private_pem); queued++; }
  console.log('[AP]', kind, site.slug, '→', targetNoteId, 'queued', queued, 'inbox(es)');
  return { ok: true, delivered: queued };
}

// Notifications inbox: new followers + replies/likes/boosts on this site's posts.
export function getNotifications(slug, limit) {
  // Per-source cap scales with the requested limit so Messages can page deep
  // (Load more). Bounded so a huge offset can't ask for unbounded rows.
  const L = Math.min(1000, Math.max(80, limit || 60));
  const out = [];
  try {
    for (const f of db.prepare('SELECT actor_uri, created_at FROM ap_followers WHERE slug = ? ORDER BY created_at DESC LIMIT ?').all(slug, L)) {
      out.push({ type: 'follow', handle: deriveHandle(f.actor_uri), url: f.actor_uri, created_at: f.created_at });
    }
  } catch { /* ignore */ }
  try {
    const rows = db.prepare(`
      SELECT i.id AS interaction_id, i.kind, i.actor_uri, i.actor_name, i.actor_handle, i.actor_url, i.actor_icon, i.content, i.created_at, i.published, i.visibility,
             i.emoji_json, i.actor_emoji_json, i.media_json, i.quote_json, i.embed_json,
             p.slug AS post_slug, p.title AS post_title
      FROM ap_interactions i LEFT JOIN posts p ON p.id = i.post_id
      WHERE p.site_id = (SELECT id FROM sites WHERE slug = ?)
      ORDER BY i.created_at DESC LIMIT ?
    `).all(slug, L);
    for (const r of rows) out.push({
      type: r.kind, name: r.actor_name, handle: r.actor_handle, url: r.actor_url, icon: r.actor_icon,
      // Waar een antwoord uit de draad heen moet: het id is de parent voor
      // deliverReply, de uri het adres voor een direct bericht.
      interactionId: r.interaction_id, actorUri: r.actor_uri,
      content: stripLeadingMentions(r.content), post_slug: r.post_slug, post_title: r.post_title, created_at: r.created_at,
      // When the post was written, for display. created_at (when it reached us)
      // stays the sort key and the unread watermark: a note that federated late
      // is still new to you.
      published: r.published,
      emoji_json: r.emoji_json, actor_emoji_json: r.actor_emoji_json,   // FEP-9098 (messages render)
      media_json: r.media_json, quote_json: r.quote_json, embed_json: r.embed_json,   // rendered like a Krant post
      // followers/direct = a private message to the owner (not on the public thread) → 🔒 in Messages
      visibility: r.visibility || 'public',
    });
  } catch { /* ignore */ }
  try {
    for (const r of db.prepare('SELECT actor_uri, actor_name, actor_handle, actor_icon, content, objects, created_at FROM ap_reports WHERE slug = ? ORDER BY created_at DESC LIMIT ?').all(slug, L)) {
      // The reported objects: our own notes resolve to post links so the owner
      // sees WHICH post the report is about; other URIs (e.g. the actor itself)
      // are skipped — the report row already names the account.
      const about = [];
      try {
        for (const u of JSON.parse(r.objects || '[]')) {
          const m = String(u).match(/\/ap\/notes\/([^/?#]+)/);
          if (!m) continue;
          const p = db.prepare('SELECT slug, title FROM posts WHERE id = ?').get(decodeURIComponent(m[1]));
          if (p) about.push({ slug: p.slug, title: p.title || p.slug });
        }
      } catch { /* malformed objects json → no links */ }
      out.push({ type: 'report', name: r.actor_name, handle: r.actor_handle, url: r.actor_uri, icon: r.actor_icon, content: r.content, objects: about, created_at: r.created_at });
    }
  } catch { /* ignore */ }
  try {
    for (const r of db.prepare(`SELECT object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, actor_url, content, wave, help_request, created_at, published,
                                       emoji_json, actor_emoji_json, media_json, quote_json, embed_json
                                FROM ap_mentions WHERE slug = ? ORDER BY created_at DESC LIMIT ?`).all(slug, L)) {
      out.push({ type: 'mention', name: r.actor_name, handle: r.actor_handle, url: r.actor_url || r.actor_uri, icon: r.actor_icon, content: stripLeadingMentions(r.content), note_url: r.note_url || r.object_uri, wave: r.wave ? 1 : 0, help_request: r.help_request ? 1 : 0, actorUri: r.actor_uri, created_at: r.created_at, published: r.published,
        // Same trimmings a Krant row has, so Berichten renders the post identically.
        emoji_json: r.emoji_json, actor_emoji_json: r.actor_emoji_json, media_json: r.media_json, quote_json: r.quote_json, embed_json: r.embed_json });
    }
  } catch { /* ignore */ }
  // Your own polls that have closed → a "results are in" item, derived read-time
  // from poll_json (Scheduler marks closed=1) with the tally via ownPollView.
  try {
    const site = db.prepare('SELECT id FROM sites WHERE slug = ?').get(slug);
    if (site) {
      const polls = db.prepare(`
        SELECT id, slug, title, poll_json FROM posts
        WHERE site_id = ? AND poll_json IS NOT NULL
          AND json_extract(poll_json, '$.closed') = 1
          AND json_extract(poll_json, '$.endTime') IS NOT NULL
        ORDER BY json_extract(poll_json, '$.endTime') DESC LIMIT 20`).all(site.id);
      for (const p of polls) {
        const view = ownPollView(p);
        if (!view) continue;
        let endTime = null; try { endTime = JSON.parse(p.poll_json).endTime; } catch { /* keep null */ }
        out.push({ type: 'poll_done', post_slug: p.slug, post_title: p.title, poll: view, created_at: endTime || null });
      }
    }
  } catch { /* ignore */ }
  // NaN-safe sort: one row with a missing/garbled created_at would otherwise make the
  // comparator return NaN and scramble the WHOLE ordering (seen live: follow rows landing
  // between likes, which also broke Messages' like-grouping).
  out.sort((a, b) => _msgTs(b) - _msgTs(a));
  return out.slice(0, limit || 60);
}
function _msgTs(x) { const t = Date.parse((x && x.created_at) || ''); return Number.isFinite(t) ? t : 0; }

// ── Blocking / defederation ───────────────────────────────────────
// Extracted to BlocklistService (shared: Klonkt's Block tab + Shaer's "in
// Orbit"). Thin delegations keep every existing caller working.
export function listBlocks(slug) { return Blocklist.listBlocks(slug); }

// True if an actor (or its whole domain) is blocked anywhere on this instance.
// Vote on a remote fediverse poll (a cached Question). A ballot = a Create(Note) carrying only a
// `name` (the chosen option) + inReplyTo the Question, addressed to the poll's author — the
// Mastodon-standard vote. Records our choice locally + optimistically bumps the counts; the
// author's Update(Question) refreshes the authoritative totals when it arrives.
export async function voteOnPoll(site, questionId, choices) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !questionId) return { error: 'config' };
  let row; try { row = db.prepare('SELECT author_uri, poll_json FROM ap_timeline WHERE id = ? AND slug = ? LIMIT 1').get(questionId, site.slug); } catch { /* ignore */ }
  if (!row || !row.poll_json) return { error: 'not_found' };
  let poll; try { poll = JSON.parse(row.poll_json); } catch { return { error: 'not_found' }; }
  if (poll.closed) return { error: 'closed' };
  if (poll.voted) return { error: 'already' };
  const valid = new Set(poll.options.map((o) => o.name));
  const picks = (Array.isArray(choices) ? choices : [choices]).map(String).filter((c) => valid.has(c));
  if (!picks.length) return { error: 'invalid' };
  const chosen = poll.multiple ? [...new Set(picks)] : [picks[0]];
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const authorUri = row.author_uri || null;
  const author = authorUri ? await fetchActor(authorUri).catch(() => null) : null;
  const inbox = author && (author.inbox || (author.endpoints && author.endpoints.sharedInbox));
  if (!inbox) return { error: 'unreachable' };
  for (const name of chosen) {
    const nid = `${me}/votes/${Date.now()}-${rid()}`;
    const note = { id: nid, type: 'Note', attributedTo: me, to: authorUri ? [authorUri] : [], name, inReplyTo: questionId, published: new Date().toISOString() };
    const create = { '@context': AP_CONTEXT, id: `${nid}/activity`, type: 'Create', actor: me, to: note.to, object: note };
    deliverWithRetry(site.slug, inbox, create, `${me}#main-key`, keys.private_pem);
  }
  // Local optimistic update (authoritative counts arrive via the author's Update(Question)).
  poll.voted = poll.multiple ? chosen : chosen[0];
  for (const o of poll.options) if (chosen.includes(o.name)) o.count = (o.count || 0) + 1;
  if (poll.voters != null) poll.voters += 1;
  try { db.prepare('UPDATE ap_timeline SET poll_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(poll), questionId, site.slug); } catch { /* ignore */ }
  return { ok: true };
}

// Vote on ANY fediverse poll by URL (the interact page) — no timeline cache needed. Fetches
// the Question fresh, validates the choice(s), and casts the Mastodon-standard ballot (a
// Create(Note) with `name` + inReplyTo) straight to the poll's author. Used for polls you find
// by URL, not just ones from accounts you follow (which go through voteOnPoll via /news).
export async function voteOnRemotePoll(site, questionUrl, choices) {
  const _mv = movedRefusal(site, 'poll-vote'); if (_mv) return _mv;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !/^https?:\/\//i.test(String(questionUrl || ''))) return { error: 'config' };
  const q = await fetchActor(questionUrl).catch(() => null); // AP GET (SSRF-guarded)
  if (!q || q.type !== 'Question' || !q.id) return { error: 'not_found' };
  const poll = parsePoll(q);
  if (!poll) return { error: 'not_found' };
  if (poll.closed) return { error: 'closed' };
  const valid = new Set(poll.options.map((o) => o.name));
  const picks = (Array.isArray(choices) ? choices : [choices]).map(String).filter((c) => valid.has(c));
  if (!picks.length) return { error: 'invalid' };
  const chosen = poll.multiple ? [...new Set(picks)] : [picks[0]];
  const authorUri = actorUriOf(q.attributedTo);
  const author = authorUri ? await fetchActor(authorUri).catch(() => null) : null;
  const inbox = author && (author.inbox || (author.endpoints && author.endpoints.sharedInbox));
  if (!inbox) return { error: 'unreachable' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  for (const name of chosen) {
    const nid = `${me}/votes/${Date.now()}-${rid()}`;
    const note = { id: nid, type: 'Note', attributedTo: me, to: [authorUri], name, inReplyTo: q.id, published: new Date().toISOString() };
    const create = { '@context': AP_CONTEXT, id: `${nid}/activity`, type: 'Create', actor: me, to: note.to, object: note };
    deliverWithRetry(site.slug, inbox, create, `${me}#main-key`, keys.private_pem);
  }
  return { ok: true };
}

// Report a remote post or account to its home instance (moderation). Sends the Mastodon-standard
// AS2 `Flag`: object = [reported account, reported status?], content = the reason, delivered to the
// reported account's inbox so their instance's moderators receive it. objectUri = a post URL (its
// author is resolved + included) OR pass actorUri to report an account directly.
export async function sendReport(site, { objectUri, actorUri, reason }) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug) return { error: 'config' };
  let targetActor = actorUri || null;
  let noteUri = null;
  if (objectUri && /^https?:\/\//i.test(objectUri)) {
    const note = await apGetJson(objectUri).catch(() => null);
    if (note && note.id) { noteUri = note.id; if (!targetActor) targetActor = actorUriOf(note.attributedTo); }
    else if (!targetActor) return { error: 'not_found' };
  }
  if (!targetActor || !/^https?:\/\//i.test(targetActor)) return { error: 'not_found' };
  const actor = await fetchActor(targetActor).catch(() => null);
  const inbox = actor && (actor.inbox || (actor.endpoints && actor.endpoints.sharedInbox)); // personal inbox → their moderators
  if (!inbox) return { error: 'unreachable' };
  const me = actorId(base, site.slug);
  const keys = getOrCreateKeys(site.slug);
  const object = [targetActor];
  if (noteUri && noteUri !== targetActor) object.push(noteUri);
  const flag = {
    '@context': AP_CONTEXT,
    id: `${me}#report-${Date.now()}-${rid()}`,
    type: 'Flag',
    actor: me,
    content: String(reason == null ? '' : reason).slice(0, 3000),
    object, // [account, status?] — Mastodon's Flag shape
    to: [targetActor],
  };
  deliverWithRetry(site.slug, inbox, flag, `${me}#main-key`, keys.private_pem);
  return { ok: true };
}

export function isBlockedAny(actorUri) { return Blocklist.isBlockedAny(actorUri); }

// Block an actor (@handle or actor URL) or a whole domain; purges their content.
// The handle resolver is ours; the storage/purge lives in BlocklistService.
export async function blockTarget(site, input) { return Blocklist.blockTarget(site, input, webfingerResolve); }

export function unblock(site, target) { return Blocklist.unblock(site, target); }

// ── Guardianship module wiring (src/services/guardianship/) ────────
// The module owns FEP-633c (context, relations, handshake, queues, the
// direct-note leg); we hand it our AP helpers ONCE and delegate. It never
// imports us back.
function selfActorId(slug) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return actorId(base, slug);
}
// Deliver one activity to one actor's inbox, signed; queued + retried on any
// hiccup so a slow or briefly-down ward server never loses the offer. Returns
// { delivered, inbox }: delivered=false means the account could not be
// resolved at all (a bad handle) — the offer stays recorded regardless.
export async function deliverToActor(site, actorUri, activity) {
  const me = selfActorId(site.slug);
  const keys = getOrCreateKeys(site.slug);
  const payload = { '@context': AP_CONTEXT, ...activity };
  // Co-location is a TRANSPORT detail, never a decision path (Robins regel,
  // 29-7). An inbox on this machine is not reachable over HTTP from this
  // machine, and should not be, so a local recipient is handed the activity
  // straight into the same inbox handler the wire would reach. Everything
  // above this line therefore behaves as if every Klonkt were remote: one code
  // path, exercised by every deployment, including the checks. Two bugs in one
  // day came from having a second, local-only path that hid a broken remote
  // one.
  const localSlug = localSlugOf(actorUri);
  if (localSlug && db.prepare('SELECT 1 FROM sites WHERE slug = ?').get(localSlug)) {
    const host = (() => { try { return new URL(selfActorId(site.slug)).host; } catch { return ''; } })();
    const req = { body: payload, ip: 'loopback', protocol: 'https', get: () => host, headers: {} };
    // The signer is us, and we say so: the actor-versus-signer check runs
    // exactly as it does over the wire, so a mismatch fails here too.
    const status = await handleInbox(req, localSlug, { id: me }).catch(() => 500);
    const ok = status >= 200 && status < 300;
    console.log('[AP]', activity.type, ok ? 'delivered (loopback) →' : `got ${status} (loopback) from`, actorUri);
    return { delivered: ok, inbox: `${actorUri}/inbox`, loopback: true, status };
  }
  const a = await fetchActor(actorUri).catch(() => null);
  const inbox = a && (a.inbox || (a.endpoints && a.endpoints.sharedInbox));
  if (!inbox) {
    console.warn('[AP] guardianship: could not resolve an inbox for', actorUri, '(offer recorded, not sent)');
    return { delivered: false, inbox: null };
  }
  try {
    const st = await deliver(inbox, payload, `${me}#main-key`, keys.private_pem);
    if (st >= 200 && st < 300) { console.log('[AP] guardianship', activity.type, 'delivered →', inbox, st); return { delivered: true, inbox }; }
    console.warn('[AP] guardianship', activity.type, 'got', st, 'from', inbox, '→ queued for retry');
  } catch (e) { console.warn('[AP] guardianship', activity.type, 'to', inbox, 'failed:', e.message, '→ queued for retry'); }
  enqueueDelivery(site.slug, inbox, payload);
  return { delivered: true, inbox };   // queued: the retry worker gets it there
}
Guardianship.wireDelivery({
  actorId, fetchActor, localActor, deliverTo: deliverToActor, deriveHandle, escHtml, linkUrls, linkHashtags,
  getOutboxRow: (id) => iStmts().getO.get(id),
  buildReplyNote, AP_CONTEXT, getOrCreateKeys, deliver, enqueueDelivery,
  // Rijke directe berichten: dezelfde sanitizer als deliverReply gebruikt, zodat
  // een antwoord uit Berichten door precies één poort gaat.
  sanitizeHtml: (h) => HtmlSanitizerService.sanitize(h),
  htmlToPlainText: (h) => HtmlSanitizerService.toPlainText(h),
});
/**
 * The actor document of a site WE host, read straight from the database.
 * Same shape fetchActor returns for anyone else, plus `local: true` so the
 * caller can take the loopback instead of a POST to our own hostname.
 * Null for an actor we do not host: that one really is fetched.
 */
function localActor(actorUri) {
  const slug = localSlugOf(actorUri);
  if (!slug) return null;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
  if (!site) return null;
  // primary_slug is what buildActor uses to pick '/' over '/user/<slug>'; the
  // actor route sets it the same way before building.
  const p = db.prepare('SELECT slug FROM sites WHERE is_primary = 1').get();
  try { return { ...buildActor(base, { ...site, primary_slug: p && p.slug }), local: true }; } catch { return null; }
}
// Which local site (if any) hosts this actor URI — used by the handshake to
// apply the local side of a commit and to derive a ward's existing guardians.
export function localSlugOf(actorUri) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!actorUri || !actorUri.startsWith(`${base}/ap/users/`)) return null;
  const slug = slugFromActorUrl(actorUri);
  if (!slug) return null;
  try { return db.prepare('SELECT slug FROM sites WHERE slug = ?').get(slug) ? slug : null; }
  catch { return null; }
}
Guardianship.wireHandshake({
  selfId: selfActorId,
  localSlug: localSlugOf,
  deliverTo: deliverToActor,
  deriveHandle,
  fetchActor,
  // Guardian PWA / Berichten push. The kid answers an incoming offer in its
  // own Berichten; an existing guardian and a commit land in the PWA.
  //
  // De labels hangen aan dezelfde sleutels als het Guardian-paneel, zodat een
  // melding en het scherm waar hij heen wijst hetzelfde woord gebruiken.
  onEvent: (slug, ev) => onGuardianshipEvent(slug, ev),
});

/**
 * Wat er gebeurt als de guardianship-module iets uitzendt.
 *
 * TWEE VERSCHILLENDE VRAGEN, en ze horen niet dezelfde te zijn: wie maak je
 * WAKKER (push kiest bewust een handvol soorten), en wat moet een scherm dat
 * openstaat WETEN (alles). Het paneel werd daarom voorheen niet gewekt door de
 * tien soorten zonder pushtekst -- die zag je pas bij de volgende tik.
 *
 * Apart en met een naam, zodat een toets erbij kan. Verstopt in de deps-literal
 * was hij onbereikbaar, en een mutatie die het wekken weghaalde bleef groen.
 */
/**
 * Hoeveel er van bewaard blijft. Een logboek dat oneindig groeit is een
 * logboek dat niemand meer opent, en dit is geschiedenis, geen archief: wat
 * ertoe doet staat vooraan.
 */
export const GUARDIAN_EVENT_KEEP = 200;

/**
 * Leg de gebeurtenis vast VOOR de melding.
 *
 * De meldingstabel beslist wie er wakker van wordt, en dat is terecht een korte
 * lijst -- maar hij besliste daarmee ook wat er onthouden werd, en dat was niet
 * de bedoeling. Elf van de achttien soorten verdwenen spoorloos, met hun inhoud:
 * een geweigerd aanbod droeg de REDEN mee tot hier en niet verder, terwijl §4.2
 * eist dat de ward en zijn guardians die te horen krijgen.
 *
 * Vastleggen en melden zijn nu twee dingen. Alles komt in het logboek; alleen
 * wat een mens moet wekken gaat ook als push de deur uit.
 */
export function recordGuardianEvent(slug, ev) {
  if (!slug || !ev || !ev.kind) return;
  try {
    db.prepare('INSERT INTO ap_guardian_events (slug, kind, payload, created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)')
      .run(slug, String(ev.kind), JSON.stringify(ev));
    db.prepare(`DELETE FROM ap_guardian_events WHERE slug = ? AND id NOT IN
                (SELECT id FROM ap_guardian_events WHERE slug = ? ORDER BY id DESC LIMIT ?)`)
      .run(slug, slug, GUARDIAN_EVENT_KEEP);
  } catch { /* een logboek mag nooit de gebeurtenis zelf breken */ }
}

/** De laatste gebeurtenissen voor dit account, nieuwste eerst. */
export function listGuardianEvents(slug, limit = 50) {
  try {
    return db.prepare('SELECT id, kind, payload, created_at FROM ap_guardian_events WHERE slug = ? ORDER BY id DESC LIMIT ?')
      .all(slug, Math.max(1, Math.min(Number(limit) || 50, GUARDIAN_EVENT_KEEP)))
      .map((r) => ({ id: r.id, kind: r.kind, created: r.created_at, ...safeJson(r.payload) }));
  } catch { return []; }
}

function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

export function onGuardianshipEvent(slug, ev) {
  recordGuardianEvent(slug, ev);
  wakeGuardian(slug);
  const p = guardianEventPush(slug, ev);
  if (p) pushEvent(slug, p);
  return p;
}

/**
 * Welke melding hoort bij een guardianship-gebeurtenis, of geen.
 *
 * Apart en puur, omdat dit een BESLISSING is en geen bezorging: de
 * guardianship-module zendt veertien soorten uit en deze tabel bepaalt welke
 * daarvan een mens wakker maken. Dat hoort toetsbaar te zijn zonder web-push
 * erbij te halen.
 */
export function guardianEventPush(slug, ev) {
  const L = pushLang(slug);
  const texts = {
    offer_received: ['push.n_guard_offer_t', 'push.n_guard_offer_b'],   // I am the ward
    offer_for_ward: ['push.n_guard_cog_t', 'push.n_guard_cog_b'],       // I co-guard this ward
    committed: ['push.n_guard_ward_t', 'push.n_guard_ward_b'],
    // §3.2: a guardian ended the relation. The ward hears that someone who
    // was looking after them has gone; a co-guardian hears they are one fewer.
    guardian_left: ['push.n_guard_left_t', 'push.n_guard_left_b'],
    coguardian_left: ['push.n_guard_cogleft_t', 'push.n_guard_cogleft_b'],
    // 5.6 gated settings. Zonder deze twee is de hele tally stil: een guardian
    // hoort niet dat er een antwoord van hem gewenst is, en dus loopt het
    // venster leeg en verloopt het voorstel. Een drempel die niemand ziet is
    // geen drempel.
    gated_review: ['push.n_gate_ask_t', 'push.n_gate_ask_b'],      // jij moet antwoorden
    gated_outcome: ['push.n_gate_done_t', 'push.n_gate_done_b'],   // er is besloten
  }[ev.kind];
  if (!texts) return null;
  const who = deriveHandle(ev.candidate || ev.guardian || ev.ward || '') || '?';
  // Een gate-melding zonder te zeggen WELKE instelling is nutteloos: er zijn er
  // meer dan een, en ze betekenen heel verschillende dingen voor een kind.
  const wat = i18nT(L, GATE_LABEL[ev.feature] || 'guardian.prop_embeds');
  const stand = i18nT(L, ev.value ? 'guardian.prop_on' : 'guardian.prop_off');
  const uitkomst = i18nT(L, GATE_OUTCOME[ev.outcome] || 'guardian.prop_st_open');
  const url = (ev.kind === 'offer_received' || ev.kind === 'guardian_left') ? `${pushPrefix(slug)}/messages` : '/guardian';
  return { type: 'guardian', title: i18nT(L, texts[0]), body: i18nT(L, texts[1], { who, wat, stand, uitkomst }), url };
}

// Van een gated feature naar het woord dat het Guardian-paneel er al voor
// gebruikt. Een onbekende feature valt terug op het algemene woord in plaats van
// de melding te laten vervallen: liever een iets vager bericht dan geen bericht.
const GATE_LABEL = {
  'shaer:externalEmbeds': 'guardian.prop_embeds',
  'shaer:externalPlayback': 'guardian.prop_play',
};
const GATE_OUTCOME = {
  accepted: 'guardian.prop_st_accepted',
  rejected: 'guardian.prop_st_rejected',
  expired: 'guardian.prop_st_expired',
};

// The notification duty of FEP-633c 3.6.2, wired once for every place a
// dormancy promotion can happen (queue reads, fan-outs, tallies): marking a
// guardian dormant MUST notify it, in protocol AND over the §6 handle. The
// one-answer rule is worthless to someone who does not know an answer is
// wanted. The handle of a committed guardian is its inbox (§6 minimum), which
// is the same door this delivery knocks on; both attempts are logged.
Guardianship.wireAvailability({
  onDormant: (wardSlug, guardianUri) => {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(wardSlug);
    if (!base || !site) return;
    const me = selfActorId(wardSlug);
    const note = {
      id: `${me}/dormant/${Date.now().toString(36)}${rid()}`,
      type: 'Note', attributedTo: me, to: [guardianUri],
      'shaer:dormant': true,
      content: '<p>You have been observed dormant as a guardian. Nothing is wrong and nothing is held against you: one answer restores everything (FEP-633c 3.6.2).</p>',
    };
    deliverToActor(site, guardianUri, { id: `${note.id}#create`, type: 'Create', actor: me, to: [guardianUri], object: note })
      .catch(() => { /* retried by the queue */ });
    console.log('[AP] guardian observed dormant (3.6.2):', guardianUri, 'ward', wardSlug, '(notified in protocol; the §6 handle is the same inbox)');
  },
});

export default {
  movedLock,
  // FEP-1580 bronkant. Vergeet je hem hier, dan werpt elke route die hem
  // aanroept een 500 en lijkt het alsof de poort dicht staat terwijl hij
  // ontbreekt (precies hoe movedLock zich een dag eerder verstopte).
  isMoveTarget, signedGetJson, signedGetHeaders,
  AP_CONTEXT, getOrCreateKeys, apWants, sendAP, actorId, noteId, stripLeadingMentions, pagedCollection,
  deriveHandle, localSlugOf, outboxSlice, PAGINA_GROOTTE,
  buildActor, buildNote, buildCreate, buildOutbox, buildFollowers, buildFollowing, buildFeatured,
  channelUrls, channelCategory, timelineFields, guessMediaType,
  siteOpenTracks, openTrack, buildTrackAudio, buildTrackCollection, buildTrackCreate, trackHostPosts,
  buildPlaylistCollection, playlistOpenTracks, listPlaylistsAP, playlistLinkTags,
  buildPostTrackCollection, uitgavePost,
  buildLibrary, libraryId,
  followerCount, deliver, fetchActor, verifyRequest, handleInbox, deliverCreate, deliverDelete, deliverUpdate, deliverActorUpdate, resyncFeaturedPins,
  feedCursor, feedChangesSince, waitForFeedChange,
  getInteractions, getInteractionById, setInteractionBoosted, setInteractionLiked, buildReplyNote, getOutboxNote, getSentNotes, deliverReply, resolveRemoteNote, noteAudience, mayReadNote,
  listOutbox, deliverOutboxDelete, deliverOutboxUpdate, deliverDirectNote,
  webfingerResolve, followActor, resolveRemoteActor, unfollowActor, handleMoveInbox, moveAccount, listFollowing, setAutoBoost, backfillFromOutbox, getTimeline, timelineRowsByIds, contentWarning, getDirectMessages, readMarkers, markRead, unreadPerConversation, messageRowsByUri, replyRowsByUri, conversationHeads, conversationHistory, isoStamp, timelineAttachments, timelineEmojis, timelineObjectLinks, timelineQuote, timelineEmbed, applyQuoteProps, deliverToActor, sendInteraction, voteOnPoll, voteOnRemotePoll,
  acceptGatedFollow, rejectGatedFollow, isWardGuardian, outboxAudience, sendFollowDecision,
  gateOutgoingFollow, performApprovedFollow, recordGuardianEvent, listGuardianEvents, GUARDIAN_EVENT_KEEP,
  parseOwnPoll, pollTally, ownPollView, deliverPollUpdate, maybeCrawlThread, sendReport, localMentionSlugs, previewCard,
  autoBoostCount, boostedCount, setReaction, getReaction, getReactionsFor, canonicalReactionUri, migrateReactions, upsertBoostedNote, getCirkelPosts, getCirkelMembers, selfHealTimeline,
  getNotifications, listBlocks, isBlockedAny, blockTarget, unblock,
  deliverWithRetry, enqueueDelivery, processDeliveryQueue, startDeliveryWorker,
  sendMaybe304, etagFor, onGuardian, wakeGuardian, onGuardianshipEvent, proposeGate, getReplyUris, getThread, filterThreadToCircle, gateAttachments, stripEmojiTags, actorObject, previewObject, quoteObject, markNotificationsSeen, countUnseenNotifications, hasPlayableAudio,
  linkifyBody, bakePostContent, bakePostContentWithMentions, listFollowers, removeFollower, listConnections,
  noteVisibility, belongsInTimeline, playerUrlFor, isRejectedObject, rejectInteraction, interactionReportTarget,
  getMessages, notificationsSeenAt, ingestOutboxActivity, c2sVisibility, actorDisplay, buildActorRef, prefersEnriched, selfAuthor, getReplyMessages, onNews, wakeNews,
};
