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
import db, { NU_ISO, isoSql } from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';
import AudioEmbedService from './AudioEmbedService.js';
import EmbedResolver from './EmbedResolver.js';
import Push from './PushService.js';
import { t as i18nT } from './i18n.js';
import Blocklist from './BlocklistService.js';
import * as Guardianship from './guardianship/index.js';
import { PUBLIC, AP_CONTEXT, safeUrl, actorId, noteId, guessMediaType, normalizeTags, tagParts, hashtagTags, buildHashtagList, pagedCollection, PAGINA_GROOTTE, artiestUrl } from './ap-core.js';
// Stap 3 van de opsplitsing (shaer-drc): het transport -- de SSRF-poort, de
// sleutels, HTTP Signatures, de bezorging met wachtrij en de ondertekende
// GET -- woont in ap-transport.js. Hier her-geëxporteerd zodat elke bestaande
// importeur blijft werken, hetzelfde patroon als de Guardianship-exports onderaan.
import {
  safeFetch, getOrCreateKeys, deliver, fetchActor,
  enqueueDelivery, deliverWithRetry, processDeliveryQueue, startDeliveryWorker,
  anySigningSlug, verifyRequest, signedGetHeaders, signedGetJson, apGetJson,
} from './ap-transport.js';
export {
  safeFetch, getOrCreateKeys, deliver, fetchActor,
  enqueueDelivery, deliverWithRetry, processDeliveryQueue, startDeliveryWorker,
  verifyRequest, signedGetHeaders, signedGetJson,
};
// Stap 4 (shaer-drc): de C2S-inname woont in ap-c2s.js. Die is een coordinator
// en krijgt zijn werktuigen uit de dienstlaag onderaan dit bestand via
// wireC2S -- de regel blijft dat een module NOOIT uit dit bestand importeert.
import { ingestOutboxActivity, wireC2S } from './ap-c2s.js';
export { ingestOutboxActivity };
// Stap 5 (shaer-drc): de leeskant van de tijdlijn woont in ap-timeline.js.
// tlStmts komt mee terug omdat de SCHRIJVERS (inbox, backfill, self-heal,
// upsertBoostedNote) hier wonen; wireTimeline krijgt onderaan zijn ene
// werktuig uit het reactiecluster.
import {
  tlStmts, wireTimeline,
  getTimeline, replyRowsByUri, timelineRowsByIds, getReplyMessages,
  feedCursor, feedChangesSince, waitForFeedChange,
  conversationHeads, conversationHistory, messageRowsByUri,
  readMarkers, markRead, unreadPerConversation, getDirectMessages,
  isoStamp, timelineAttachments, extractEmojiTags, gateAttachments,
  stripEmojiTags, timelineEmojis, extractObjectLinkTags, timelineObjectLinks,
  extractQuoteUrl, extractLinkJson, quoteHrefOf, timelineQuote,
} from './ap-timeline.js';
export {
  getTimeline, replyRowsByUri, timelineRowsByIds, getReplyMessages,
  feedCursor, feedChangesSince, waitForFeedChange,
  conversationHeads, conversationHistory, messageRowsByUri,
  readMarkers, markRead, unreadPerConversation, getDirectMessages,
  isoStamp, timelineAttachments, extractEmojiTags, gateAttachments,
  stripEmojiTags, timelineEmojis, extractObjectLinkTags, timelineObjectLinks,
  extractQuoteUrl, extractLinkJson, quoteHrefOf, timelineQuote,
};
// Stap 6 (shaer-drc): het reactiecluster woont in ap-reactions.js. Dat
// importeert tlStmts zelf statisch uit ap-timeline; alleen movedLock gaat er
// onderaan via wireReactions in.
import {
  wireReactions,
  setMyReaction, getMyReactions,
  markBoosted, unmarkBoosted, markLiked, unmarkLiked,
  migrateReactions, canonicalReactionUri, getReaction, getReactionsFor,
  setReaction, getTimelineReaction, upsertBoostedNote, boostedCount,
} from './ap-reactions.js';
export {
  setMyReaction, getMyReactions,
  markBoosted, unmarkBoosted, markLiked, unmarkLiked,
  migrateReactions, canonicalReactionUri, getReaction, getReactionsFor,
  setReaction, getTimelineReaction, upsertBoostedNote, boostedCount,
};
// Stap 7 (shaer-drc): de volgwinkel woont in ap-following.js. fwStmts komt
// mee terug voor de Accept-tak van de inbox en de verhuizing (FEP-7628);
// wireFollowing krijgt onderaan zijn zes werktuigen.
import {
  fwStmts, wireFollowing,
  webfingerResolve, listFollowing, setAutoBoost,
  followActor, resolveRemoteActor, unfollowActor,
} from './ap-following.js';
export {
  webfingerResolve, listFollowing, setAutoBoost,
  followActor, resolveRemoteActor, unfollowActor,
};
// Stap 8 (shaer-drc): de peilingen wonen in ap-polls.js. parsePoll,
// applyPollToNote en recordPollBallot komen terug voor de inbox, buildNote en
// de backfill, maar blijven naar buiten toe prive zoals ze waren.
import {
  wirePolls,
  parsePoll, applyPollToNote, recordPollBallot,
  parseOwnPoll, pollTally, ownPollView, deliverPollUpdate,
  voteOnPoll, voteOnRemotePoll,
} from './ap-polls.js';
export {
  parseOwnPoll, pollTally, ownPollView, deliverPollUpdate,
  voteOnPoll, voteOnRemotePoll,
};
// Stap 9 (shaer-drc): de inbox woont in ap-inbox.js. De schakelkast krijgt
// onderaan zijn vierendertig werktuigen via wireInbox.
import { handleInbox, wireInbox } from './ap-inbox.js';
export { handleInbox };
// Stap 10 (shaer-drc): de Cirkel woont in ap-cirkel.js. Geen wire: hij leest
// alleen db.
import { autoBoostCount, getCirkelPosts, getCirkelMembers } from './ap-cirkel.js';
export { autoBoostCount, getCirkelPosts, getCirkelMembers };
// Doorgeven wat hier altijd vandaan kwam, zodat elke bestaande aanroep blijft werken.
export { AP_CONTEXT, actorId, noteId, guessMediaType };
// De muziekkant woont in music/ (shaer-drc). Doorgeven wat hier altijd
// vandaan kwam, zodat elke bestaande aanroep blijft werken.
import { luisteraars } from './music/index.js';
import { TRACK_KOLOMMEN,
  playlistOpenTracks, siteOpenTracks, openTrack, trackHostPosts,
  buildTrackAudio, buildTrackCollection, buildTrackCreate, trackUri, buildMixtapeObject, postMusicType,
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

const MAX_OUTBOX = 20;
// Cache-buster for the music listen-link → forces Mastodon to re-crawl a FRESH
// (square) player card. Bump this whenever the twitter:player card dimensions change.
const FEDI_CARD_VER = '2';

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
    // …and the same honesty for the OWNER gate (Robins wens, 18-8): a site
    // with approve_followers on holds follows pending until the owner decides.
    manuallyApprovesFollowers: isWard || !!site.approve_followers,
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

// fedi_open tracks → real AS2 Audio attachments (the actual file URL, served ungated) so
// EVERY client incl. the Mastodon apps plays them inline natively. Gated tracks (default)
// stay link/card-only — the file is never exposed for them. Resolve from post.content so a
// later body mutation can't affect it.
//
// Staat apart en niet meer midden in buildNote, omdat een BETAALDE post hem ook
// nodig heeft: daar staat de muur om de TEKST en niet om de muziek.
function openAudioAttachments(base, site, post) {
  const openAudio = [];
  if (!/\[\[(track|album|playlist):/i.test(post.content || '')) return openAudio;
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
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
  return openAudio;
}

// HET BANDJE OP DE DRAAD. Zonder dit stuk bestaat `Mixtape` alleen in onze
// eigen code: de playlist-collectie blijft namelijk een OrderedCollection
// (dat moet, anders verliest een lezer die `type` als tekst uitpakt het hele
// object), en dan zegt niets naar buiten toe ooit dat dit een cassette is.
// Gemeten op 21-8: in de Note van een mixtape-post kwam het woord Mixtape
// niet voor, en de hub gooide zo'n bandje daarom stil weg.
//
// Als bijlage en niet als het object zelf: de post blijft een Note, zodat
// Mastodon en alles wat `Mixtape` niet kent gewoon een bericht met audio
// ziet. Wie het type wel kent, vindt het bandje als geheel.
//
// Het bandje draagt alleen wat al open staat: playlistOpenTracks filtert op
// fedi_open. Daarom is het veilig om hem ook aan een betaalde teaser te hangen.
function mixtapeAttachment(base, site, post) {
  try {
    const soort = postMusicType(post.content || '', site.id);
    if (!soort || soort.type !== 'mixtape' || !soort.collectie || !soort.collectie.id) return null;
    const pl = db.prepare('SELECT * FROM playlists WHERE id = ? AND site_id = ?')
      .get(soort.collectie.id, site.id);
    if (!pl) return null;
    return buildMixtapeObject(base, site, { ...pl, _post: post }, playlistOpenTracks(pl.id)) || null;
  } catch { return null; /* een bandje minder is geen kapotte post */ }
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
  // content, so nothing leaks past the paywall. Images stay home too.
  //
  // MAAR DE OPENGEZETTE AUDIO REIST WEL MEE (Robin, 24-8, naar aanleiding van
  // boiert.eu/introducing-this-machine). De muur staat om de TEKST. `fedi_open`
  // is een aparte, eenrichtings, per nummer bewust gezette vlag van de eigenaar,
  // en die nummers federeren toch al los als eigen Audio-objecten met hun
  // `context` naar deze post. Hield deze tak het bandje tegen, dan hield hij
  // niets geheim -- alleen de VOLGORDE en het feit dat het een cassette is. In
  // de hub viel het bandje daardoor uiteen in vier losse nummers onder een kale
  // teaserkaart. Een cassette die terugwijst naar "lees verder (supporters)"
  // dient de betaalde post beter dan vier weesnummers.
  if (post.paid) {
    const esc = (x) => String(x || '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const _firstP = (String(post.content || '').match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [null, ''])[1] || '';
    const rawTeaser = String(post.excerpt || '').trim()
      || _firstP.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 280);
    const openBijlagen = openAudioAttachments(base, site, post);
    const band = mixtapeAttachment(base, site, post);
    // Het bandje alleen als er ook echt iets open in zit: een cassette waarvan
    // elk nummer gesloten is, is een lege doos met een titel erop.
    if (band && openBijlagen.length) openBijlagen.push(band);
    return {
      '@context': AP_CONTEXT,
      id,
      type: 'Note',
      attributedTo: aId,
      content: `${titleHtml}<p>${esc(rawTeaser)}${rawTeaser ? '…' : ''}</p><p><a href="${human}">Lees de volledige post (supporters)</a></p>`,
      url: human,
      published: toISO(post.published_at || post.created_at || Date.now()),
      ...(openBijlagen.length ? { attachment: openBijlagen } : {}),
      to: [PUBLIC],
      cc: [`${aId}/followers`],
      tag: [...hashtagTags(base, post.content)],
      replies: `${id}/replies`,
      // DE WAARSCHUWING REIST MEE (Barts melding, 15-8). Deze vroege return liet
      // `sensitive` en `summary` vallen, want die worden pas na de gewone tak
      // gezet. Gevolg: een betaalde post met een waarschuwing ging ZONDER die
      // waarschuwing de deur uit -- en de teaser is publiek, dus juist die had
      // hem nodig. Een gevoelige teaser zonder vlag is erger dan geen teaser.
      sensitive: !!post.nsfw,
      ...(post.nsfw ? { summary: post.content_warning || 'Gevoelige inhoud' } : {}),
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
  const openAudio = openAudioAttachments(base, site, post);
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

  // Het bandje als bijlage — zie mixtapeAttachment() voor het waarom.
  const tape = mixtapeAttachment(base, site, post);
  if (tape) attachment.push(tape);

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
    SELECT 'post' AS soort, p.id AS id, ${isoSql('COALESCE(p.published_at, p.created_at)')} AS wanneer
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
    // EN paid + excerpt, om exact dezelfde reden (Barts melding, 15-8). Zonder
    // `paid` is post.paid hier `undefined`, dan slaat buildNote zijn redactie
    // over en gaat de VOLLEDIGE tekst van een betaalde post de outbox uit. Zo
    // kwam een post via een hub-actor gewoon te lezen. `excerpt` moet mee omdat
    // de teaser daaruit komt; zonder dat veld valt hij terug op de eerste
    // alinea van precies de tekst die verborgen hoort te blijven.
    //
    // Dit is een KOLOMMENLIJST, en die faalt stil: een vergeten kolom is
    // `undefined` en niet een fout. Wie hier een veld toevoegt waar buildNote
    // op beslist, moet het HIER ook toevoegen.
    `SELECT id, slug, title, excerpt, content, cover_image_url, cover_video_url, nsfw, content_warning,
            c2s_attachments, quote_json, embed_json, published_at, created_at,
            fan_only, ap_visibility, paid, paid_min_cents
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
export function buildFeatured(base, site, posts, { page = false } = {}) {
  const id = `${actorId(base, site.slug)}/featured`;
  const items = (posts || []).map((p) => buildNote(base, site, p));
  return pagedCollection(id, items, { page });
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
/**
 * Een volger verwijderen, en het hem ook LATEN WETEN (Robin, 21-8).
 *
 * Reject(Follow) is het standaardsignaal voor "je volgt me niet meer": de
 * andere kant ruimt de relatie dan op in plaats van te blijven denken dat hij
 * volgt. Zonder dit merkte de hub niets -- die bleef als volger in zijn eigen
 * boeken staan terwijl er nooit meer iets werd bezorgd.
 *
 * Verwijderen gaat altijd door; de melding is een gunst en mag mislukken.
 */
export function removeFollower(slug, id) {
  const rij = db.prepare('SELECT actor_uri FROM ap_followers WHERE slug = ? AND id = ?').get(slug, id);
  const info = db.prepare('DELETE FROM ap_followers WHERE slug = ? AND id = ?').run(slug, id);
  if (info.changes > 0 && rij && rij.actor_uri) meldNietLangerVolger(slug, rij.actor_uri);
  return info.changes > 0;
}

/** Reject(Follow) naar een ex-volger; faalt stil, want de relatie is al weg. */
export function meldNietLangerVolger(slug, actorUri) {
  try {
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const me = actorId(base, slug);
    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
    if (!site) return;
    const reject = {
      '@context': AP_CONTEXT,
      id: `${me}#reject-follow-${Date.now()}-${rid()}`,
      type: 'Reject',
      actor: me,
      to: [actorUri],
      object: { type: 'Follow', actor: actorUri, object: me },
    };
    deliverToActor(site, actorUri, reject)
      .then((r) => console.log('[AP] Reject(Follow)', slug, '→', actorUri, r && r.delivered ? 'bezorgd' : 'niet bezorgd'))
      .catch(() => {});
  } catch { /* nooit blokkerend */ }
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
    _insI = db.prepare(`INSERT OR IGNORE INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, parent_uri, visibility, emoji_json, actor_emoji_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,${NU_ISO})`);
    _delLA = db.prepare('DELETE FROM ap_interactions WHERE kind = ? AND post_id = ? AND actor_uri = ?');
    _delReply = db.prepare("DELETE FROM ap_interactions WHERE kind = 'reply' AND object_uri = ?");
    _listI = db.prepare('SELECT id, kind, object_uri, parent_uri, actor_uri, actor_name, actor_handle, actor_url, actor_icon, content, published, created_at, acted_boost, acted_like, visibility, emoji_json, actor_emoji_json FROM ap_interactions WHERE post_id = ? ORDER BY created_at ASC');
    _getI = db.prepare('SELECT * FROM ap_interactions WHERE id = ?');
    _insO = db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, language, attachments, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,${NU_ISO})`);
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
  // Deze lijst filterde op fan_only maar NIET op paid, en haalde `paid` ook niet
  // op -- dus stond post.paid op undefined, sloeg buildNote zijn redactie over,
  // en duwden we bij ELKE nieuwe volger twintig posts de deur uit met de
  // volledige tekst van de betaalde erbij. Een push, dus onherroepelijk: het
  // staat daarna in hun inbox. Zelfde reden voor ap_visibility, dat hier
  // helemaal ontbrak: een friends- of direct-post hoort niet in een backfill.
  // (Barts melding, 15 augustus 2026.)
  const recent = db.prepare(
    `SELECT id, slug, title, excerpt, content, cover_image_url, cover_video_url, nsfw, content_warning,
            c2s_attachments, published_at, created_at, fan_only, ap_visibility, paid, paid_min_cents
     FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
       AND IFNULL(ap_visibility, 'public') = 'public'
     ORDER BY ${isoSql('COALESCE(published_at, created_at)')} DESC LIMIT 20`
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
/**
 * Delete(Tombstone) voor een van onze EIGEN objecten, naar alle volgers.
 *
 * De romp staat apart omdat een post niet het enige is dat wij de draad op
 * sturen. Een track is een eersterangs Audio-object met een eigen id
 * (shaer-0nh), en die werd bij verwijderen nergens aangekondigd: de rij ging
 * weg, het object ging 404 en elke server die hem had geindexeerd hield hem
 * voor altijd. Op de hub kwam dat op 21-8 aan het licht als een track die naar
 * een dode URL wees.
 *
 * Het object-id komt van de aanroeper. Dat moet ook wel: bij verwijderen is de
 * rij vaak al weg, dus er valt niets meer op te zoeken.
 */
export async function deliverObjectDelete(site, objectId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !objectId) return;
  const followers = fStmts().list.all(site.slug);
  if (!followers.length) return;
  const inboxes = [...new Set(followers.map((f) => f.shared_inbox || f.inbox).filter(Boolean))];
  const keys = getOrCreateKeys(site.slug);
  const me = actorId(base, site.slug);
  const del = {
    '@context': AP_CONTEXT,
    id: `${objectId}#delete-${Date.now()}-${rid()}`,
    type: 'Delete',
    actor: me,
    to: [PUBLIC],
    object: { id: objectId, type: 'Tombstone' },
  };
  for (const inbox of inboxes) deliverWithRetry(site.slug, inbox, del, `${me}#main-key`, keys.private_pem);
}

export async function deliverDelete(site, post) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !post || !post.id) return;
  return deliverObjectDelete(site, noteId(base, post.id));
}

/**
 * Zelfde voor een track. Roep dit aan VOOR het verwijderen van de rij, net als
 * bij een post: daarna is `id` er nog wel maar de context niet meer.
 */
export async function deliverTrackDelete(site, trackId) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!base || !site || !site.slug || !trackId) return;
  return deliverObjectDelete(site, trackUri(base, site, trackId));
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
     ORDER BY pinned DESC, ${isoSql('COALESCE(published_at, created_at)')} ASC LIMIT 20`
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



// Store the author's display-name emoji map (from actorInfo().emojis) on a
// timeline row, so the byline can render a ":shortcode:" name. No-op when the
// name has no custom emoji (the common case).
function storeAuthorEmoji(id, slug, ai) {
  if (!ai || !ai.emojis || !Object.keys(ai.emojis).length) return;
  try { db.prepare('UPDATE ap_timeline SET author_emoji_json = ? WHERE id = ? AND slug = ?').run(JSON.stringify(ai.emojis), id, slug); } catch { /* ignore */ }
}

// A display-name emoji map (actorInfo().emojis) → JSON to store, or null.
function emojiJsonOf(map) { return (map && Object.keys(map).length) ? JSON.stringify(map) : null; }



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
//
// De BEZORGING hoort ook hier: BlocklistService kent de database, niet het
// afleveren. Een Block gaat naar de inbox van wie je blokkeert, een
// Undo(Block) bij het opheffen -- zonder retry-wachtrij, want een blokkade
// wacht niet op een server die even plat ligt (en bij opheffen komt de ander
// vanzelf weer langs).
async function bezorgBlokkade(site, target, undo) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = actorId(base, site.slug);
  const blok = { id: `${me}#block-${Date.now()}-${rid()}`, type: 'Block', actor: me, object: target, to: [target] };
  const activiteit = undo
    ? { '@context': AP_CONTEXT, id: `${me}#unblock-${Date.now()}-${rid()}`, type: 'Undo', actor: me, object: blok, to: [target] }
    : { '@context': AP_CONTEXT, ...blok };
  const r = await deliverToActor(site, target, activiteit);
  console.log('[AP]', undo ? 'Undo(Block)' : 'Block', site.slug, '→', target, r && r.delivered ? 'bezorgd' : 'niet bezorgd');
}

export async function blockTarget(site, input) { return Blocklist.blockTarget(site, input, webfingerResolve, bezorgBlokkade); }

export function unblock(site, target) { return Blocklist.unblock(site, target, bezorgBlokkade); }

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

// De C2S-inname zijn werktuigen geven (stap 4, shaer-drc). Onderaan, zodat
// elke const hierboven al bestaat; een verzoek kan pas na deze evaluatie
// binnenkomen, dus de koppeling is altijd eerder dan de eerste aanroep.
wireC2S({
  proposeGate, deriveHandle, resolveRemoteNote, deliverReply, markRead,
  postIdFromNoteUrl, sendInteraction, setReaction, gateOutgoingFollow,
  followActor, unfollowActor, blockTarget, unblock, deliverDelete,
  deliverOutboxDelete, bakePostContent, bakePostContentWithMentions,
  deliverCreate,
});
// En de tijdlijn-leeskant zijn ene werktuig (stap 5): liked/boosted komen
// sinds stap 6 uit ap-reactions, maar de koppeling blijft HIER lopen -- twee
// zustermodules die elkaar importeren zou een kring zijn.
wireTimeline({ getReactionsFor });
// Het reactiecluster zijn ene werktuig (stap 6): de verhuisgrendel (FEP-7628).
wireReactions({ movedLock });
// De volgwinkel zijn zes werktuigen (stap 7): de verhuisweigering, de
// §5.3-poortwachter, de actorlezer, de id-staart en de twee bezorgers.
wireFollowing({ movedRefusal, gateOutgoingFollow, actorInfo, rid, backfillFromOutbox, deliverToActor });
// De peilingen hun vier werktuigen (stap 8): de Update-bezorging voor de
// telling, de id-staart, de verhuisweigering en de attributedTo-lezer.
wirePolls({ deliverUpdate, rid, movedRefusal, actorUriOf });
// De schakelkast (stap 9): de lijst is bewust lang -- hij is de kaart van wat
// de inbox aanraakt, en elke naam die eraf gaat is een cluster dat zelf
// verhuisd is.
wireInbox({
  actorInfo, actorUriOf, backfillFromOutbox, backfillNewFollower,
  belongsInTimeline, contentWarning, emojiJsonOf, fetchNoteAP,
  findThreadTarget, fStmts, handleFollowApprovalInbox, handleMoveInbox,
  isBlockedAny, isRejectedObject, iStmts, libraryOwnerSlug, localMentionSlugs,
  localPostExists, localSlugOf, mediaFromNote, noteVisibility,
  postIdFromNoteUrl, pushEvent, pushLang, pushPostCtx, pushPrefix,
  resolveCard, resolveExternalEmbed, resolveQuote, rid, slugFromActorUrl,
  storeAuthorEmoji, timelineFields, wakeGuardian,
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
  followerCount, deliver, fetchActor, verifyRequest, handleInbox, deliverCreate, deliverDelete, deliverObjectDelete, deliverTrackDelete, deliverUpdate, deliverActorUpdate, resyncFeaturedPins,
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
