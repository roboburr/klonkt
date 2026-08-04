/**
 * ActivityPub — public endpoints (Phase 1: discover + fetch).
 *
 *   GET /.well-known/webfinger?resource=acct:<slug>@<host>
 *   GET /ap/users/:slug            actor (content-negotiated: AP-JSON vs redirect to HTML profile)
 *   GET /ap/users/:slug/outbox     OrderedCollection of Create(Note)
 *   GET /ap/users/:slug/followers  count-only OrderedCollection
 *   GET /ap/users/:slug/featured   pinned posts (Mastodon "Featured" tab)
 *   GET /ap/notes/:id              a single Note
 *   POST /ap/users/:slug/inbox, /ap/inbox  → 202 (Follow/Accept + signature verify: next step)
 *
 * Mounted before resolveSite; resolves the site by slug itself.
 */
import express from 'express';
import { readFileSync } from 'fs';
import db from '../config/database.js';
import AP from '../services/ActivityPubService.js';
import { apReadLimiter, apInboxLimiter } from '../middleware/rate-limit.js';
import { apEnabled } from '../services/SettingsService.js';
import OAuth from '../services/OAuthService.js';
import * as Guardianship from '../services/guardianship/index.js';
import { getPrimarySite } from '../middleware/site.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { mediaDir } from '../config/paths.js';

const router = express.Router();
// The whole fediverse layer can be turned off (solo "no federation" mode):
// then /ap/*, WebFinger and NodeInfo are simply gone — the site is undiscoverable
// and unfederatable. CRITICAL: this router is mounted at root (app.use(apRoutes)), so a
// blanket res.status(404) here ran for EVERY request and 404'd the whole site when AP was
// off. Use next('router') to SKIP this router entirely and let the normal routes handle it
// (the /ap/* paths then fall through to the app's normal 404, which is correct).
router.use((req, res, next) => { if (!apEnabled()) return next('router'); next(); });
// Generous per-IP baseline over all /ap/* (reads). The inbox POST gets an
// additional, tighter cap inline (it triggers outbound fetches).
router.use(apReadLimiter);
let _ver = '1.0.0';
try { _ver = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version || _ver; } catch { /* keep default */ }

const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const hostOf = (req) => { try { return new URL(baseUrl(req)).host; } catch { return req.get('host'); } };
const publicSite = (slug) => db.prepare('SELECT * FROM sites WHERE slug = ? AND (is_public IS NULL OR is_public = 1)').get(slug);
// The primary site, via the one source of truth in middleware/site.js — which
// falls back to the oldest site when nothing carries the is_primary flag. This
// route used to keep its own is_primary-only copy, so a fresh instance whose
// site was never flagged served its HTML at / (that resolver falls back) while
// WebFinger and the actor route insisted it had no primary at all.
const primarySlug = () => { const s = getPrimarySite(); return s && s.slug; };
// A hostname as a human types it and as DNS stores it are the same host:
// `🩵.is.wildenvrij.nl` IS `xn--zz9h.is.wildenvrij.nl`. WHATWG URL does the IDNA,
// so compare the ASCII form and never the bytes the client happened to send.
const asciiHost = (h) => {
  try { return new URL(`https://${h}`).host.toLowerCase(); } catch { return String(h).trim().toLowerCase(); }
};

// ── WebFinger ─────────────────────────────────────────────────────
router.get('/.well-known/webfinger', (req, res) => {
  const m = String(req.query.resource || '').match(/^acct:([^@]+)@(.+)$/i);
  if (!m) return res.status(400).type('text/plain').send('bad resource');
  const user = m[1];
  let site = publicSite(user);
  // `acct:<host>@<host>` asks for this server's primary actor — the convention
  // Shaer's Handle relies on so a Ward is reachable without knowing anyone's
  // slug. Typing `🩵.is.wildenvrij.nl`, pasting `https://🩵.is.wildenvrij.nl`
  // (which the client's URL parser silently punycodes) and sending the xn--
  // form by hand are three spellings of one address; all arrive here with the
  // host sitting in the user position, and all must find the same actor.
  if (!site && asciiHost(user) === asciiHost(hostOf(req))) {
    const slug = primarySlug();
    if (slug) site = publicSite(slug);
  }
  if (!site) return res.status(404).end();
  res.type('application/jrd+json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  const actorUri = AP.actorId(baseUrl(req), site.slug);
  const profileUrl = baseUrl(req) + (site.slug === primarySlug() ? '/' : `/user/${encodeURIComponent(site.slug)}`);
  res.send(JSON.stringify({
    subject: `acct:${site.slug}@${hostOf(req)}`,
    aliases: [actorUri, profileUrl],
    links: [
      { rel: 'self', type: 'application/activity+json', href: actorUri },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: profileUrl },
    ],
  }));
});

// ── Actor ─────────────────────────────────────────────────────────
router.get('/ap/users/:slug', (req, res) => {
  const site = publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  if (!AP.apWants(req)) {
    // A browser hit the AP actor URL → send them to the human profile.
    const human = site.slug === primarySlug() ? '/' : `/user/${encodeURIComponent(site.slug)}`;
    return res.redirect(302, baseUrl(req) + human);
  }
  site.primary_slug = primarySlug();
  AP.sendAP(res, AP.buildActor(baseUrl(req), site));
});

// ── Outbox ────────────────────────────────────────────────────────
router.get('/ap/users/:slug/outbox', async (req, res) => {
  const site = publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  // Authorized fetch (30-7): who is asking decides what they see.
  //  - the owner's own app (bearer) and a verified accepted follower or
  //    guardian get the friends-only history too, so a NEW friend's backfill
  //    brings the past along (Robins besluit: vrienden krijgen de
  //    geschiedenis mee);
  //  - a verified caller this instance BLOCKS gets an EMPTY collection, not
  //    even the public set: a block is a closed door, and a signed fetch is
  //    the caller knocking with their name on it;
  //  - everyone else gets the public collection, exactly as before.
  const bearer = OAuth.verifyBearer(req.headers.authorization);
  let verifiedActor = null;
  if (!bearer && req.headers['signature']) {
    const verified = await AP.verifyRequest(req).catch(() => null);
    verifiedActor = verified && verified.id;
  }
  const audience = AP.outboxAudience(req.params.slug, {
    bearerSlug: bearer ? bearer.site.slug : null,
    verifiedActor,
  });
  if (audience === 'blocked') {
    return AP.sendAP(res, AP.buildOutbox(baseUrl(req), site, []), 'private, no-store');
  }
  const fanClause = audience === 'friend' ? '' : "AND (fan_only IS NULL OR fan_only = 0)";
  const posts = db.prepare(
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, c2s_attachments, published_at, created_at
     FROM posts WHERE site_id = ? AND status = 'published' ${fanClause}
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20`
  ).all(site.id);
  const ob = AP.buildOutbox(baseUrl(req), site, posts);
  if (audience === 'friend') {
    // The owner's app builds its feed from this leg, and every note here is
    // by the site itself: give it the same `shaer:author` byline the timeline
    // entries carry, so your own cards get a header too (avatar + name).
    const me = AP.selfAuthor(baseUrl(req), site);
    for (const it of ob.orderedItems) {
      if (it && it.object && typeof it.object === 'object') it.object['shaer:author'] = me;
    }
  }
  AP.sendAP(res, ob, audience === 'friend' ? 'private, no-store' : undefined);
});

// ── Follow-QR (Robins verzoek, 31-7) ──────────────────────────────
// The QR carries an HTTPS url, not the share: scheme: camera apps (Google
// Lens voorop) treat unknown schemes as plain text and only offer to OPEN
// https links (Robins melding, 31-7). The url lands on the interstitial
// below, whose one big button fires the share: scheme — from a browser the
// custom scheme DOES work (BROWSABLE intent-filter; Safari prompts).
// Public on purpose: it encodes only the public handle, and the app's plain
// image loaders carry no bearer.
router.get('/ap/users/:slug/follow-qr.png', async (req, res) => {
  const site = db.prepare('SELECT slug FROM sites WHERE slug = ?').get(req.params.slug);
  if (!site) return res.status(404).end();
  try {
    const { default: QRCode } = await import('qrcode');
    const png = await QRCode.toBuffer(`${baseUrl(req)}/ap/users/${encodeURIComponent(site.slug)}/follow`, { width: 600, margin: 1 });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (e) {
    console.warn('[AP] follow-qr failed:', e && e.message);
    res.status(500).end();
  }
});

// The interstitial the QR opens: one big button into Shaer, and the handle
// in plain sight for whoever has no Shaer (yet).
router.get('/ap/users/:slug/follow', (req, res) => {
  const site = db.prepare('SELECT slug, title FROM sites WHERE slug = ?').get(req.params.slug);
  if (!site) return res.status(404).end();
  const host = new URL(baseUrl(req)).host;
  const esc = (t) => String(t).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const handle = `@${site.slug}@${host}`;
  const name = esc(site.title || site.slug);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Follow ${name}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: linear-gradient(160deg, #5A32E6, #2a1a5e); color: #fff; text-align: center; }
  main { padding: 32px; max-width: 420px; }
  h1 { font-size: 1.5rem; margin: 0 0 .4rem; }
  .handle { opacity: .85; font-family: ui-monospace, monospace; word-break: break-all; }
  a.go { display: block; margin: 28px auto 14px; padding: 16px 28px; border-radius: 999px; background: #fff; color: #2a1a5e;
         font-weight: 700; font-size: 1.15rem; text-decoration: none; }
  p.small { font-size: .85rem; opacity: .75; line-height: 1.5; }
</style></head><body><main>
  <h1>Follow ${name}</h1>
  <div class="handle">${esc(handle)}</div>
  <a class="go" href="share:social/follow/AP/${esc(handle)}">Open in Shaer</a>
  <p class="small">No Shaer? Any fediverse app can follow ${esc(handle)}.</p>
</main></body></html>`);
});

// ── Long-poll (owner only, Robins verzoek 31-7) ───────────────────
// Hold the request until something push-worthy lands for this account, then
// answer 200 (news: re-read your feed) or 204 after ~25s (nothing: re-arm).
// The thread in the app stays live without interval polling.
router.get('/ap/users/:slug/inbox/wait', (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  if (!auth || auth.site.slug !== req.params.slug) return res.status(403).end();
  let settled = false;
  const done = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    off();
    if (!res.headersSent) res.status(code).end();
  };
  const off = AP.onNews(auth.site.slug, () => done(200));
  const timer = setTimeout(() => done(204), 25_000);
  req.on('close', () => done(204));
});

// ── Blocked collection (owner only, AP §5.6) ──────────────────────
// The server blocklist is the source of truth for Shaer's "in Orbit":
// clients read it here instead of keeping their own state. Actor-kind
// blocks only (domain blocks are instance policy, not an Orbit member).
router.get('/ap/users/:slug/blocked', (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  if (!auth || auth.site.slug !== req.params.slug) return res.status(403).end();
  const base = baseUrl(req);
  const items = AP.listBlocks(auth.site.slug)
    .filter((b) => b.kind === 'actor')
    .map((b) => b.target);
  AP.sendAP(res, {
    '@context': AP.AP_CONTEXT,
    id: `${base}/ap/users/${auth.site.slug}/blocked`,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  });
});

// ── Guardian queues (owner only, FEP-633c, shaer:queues) ──────────
// The dashboard collections the Shaer clients read: pending adoption offers,
// gated follows (empty in Klonkt for now) and the guardian's wards. Same
// contract as the Shaer test daemon.
function queueRoute(name, build) {
  router.get(`/ap/users/:slug/queues/${name}`, (req, res) => {
    const auth = OAuth.verifyBearer(req.headers.authorization);
    if (!auth || auth.site.slug !== req.params.slug) return res.status(403).end();
    const base = baseUrl(req);
    const me = `${base}/ap/users/${auth.site.slug}`;
    AP.sendAP(res, { '@context': AP.AP_CONTEXT, ...build(`${me}/queues/${name}`, auth.site.slug, me) });
  });
}
queueRoute('offers', (id, slug, me) => Guardianship.offersCollection(id, slug, me));
queueRoute('follows', (id) => Guardianship.followsCollection(id));
// §5.3 turned around (shaer-p729): what this ward has asked to follow, still
// waiting on its guardians. Owner-only like the rest — who a child wants to
// follow is nobody else's business.
queueRoute('outgoing-follows', (id, slug, me) => Guardianship.outgoingFollowsCollection(id, slug, me));
queueRoute('wards', (id, slug) => Guardianship.wardsCollection(id, slug));
// Availability (FEP-633c 3.6.1) is never public: the ward reads its
// guardians' real states here and nowhere else.
queueRoute('guardians', (id, slug) => Guardianship.guardiansCollection(id, slug));

// ── Inbox read (owner only, AP C2S) ───────────────────────────────
// GET on the inbox is part of ActivityPub C2S: the account owner (a bearer
// scoped to this site) reads recent inbound posts (the timeline: accounts
// they follow) as Create(Note) items, so an app (Shaer) can build a unified
// feed. Anyone else gets 403; the inbox stays write-only for the public.
router.get('/ap/users/:slug/inbox', (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  if (!auth || auth.site.slug !== req.params.slug) return res.status(403).end();
  const base = baseUrl(req);
  // Gated feature (FEP-633c): may this account see EXTERNAL embeds? A ward's
  // world outside the fediverse is the guardians' call. The gate is applied
  // here, at serialisation: a blocked embed is never sent, because an embed the
  // client merely hides has still been delivered to the device.
  const isWard = (() => { try { return Guardianship.listGuardians(auth.site.slug).length > 0; } catch { return false; } })();
  const embedsAllowed = Guardianship.externalEmbedsAllowed(auth.site.external_embeds, isWard);
  // The heavier sibling (5.6): may a third party's PLAYER run inside the app,
  // and may a link hand the child over to a browser? Both are the guardians'
  // call, both default to off for a ward, and both need the preview gate open
  // first: you cannot play, or follow, what you may not see. Served here so
  // the app knows what it may offer instead of guessing.
  const playbackAllowed = embedsAllowed
    && Guardianship.externalPlaybackAllowed(auth.site.external_playback, isWard);
  const posts = AP.getTimeline(auth.site.slug, 60).map((t) => ({
    id: `${t.id}#create`,
    type: 'Create',
    actor: t.author_uri,
    published: t.published || t.created_at || undefined,
    object: {
      id: t.id,
      type: 'Note',
      attributedTo: t.author_uri,
      content: t.content,
      url: t.url || undefined,
      published: t.published || t.created_at || undefined,
      sensitive: !!t.nsfw,
      summary: t.cw || undefined,
      // Friends' media travels along (media_json → AS2 attachment), so the
      // client renders their images/audio like own outbox posts.
      attachment: AP.timelineAttachments(t.media_json),
      // The note's preserved tags, so the client can render them: FEP-9098
      // Emoji tags (:shortcode: → image) and FEP-e232 Link tags (quotes /
      // inline object references). Combined into one `tag` array; omitted
      // when the note has neither.
      tag: (() => {
        const tags = [...(AP.timelineEmojis(t.emoji_json) || []), ...(AP.timelineObjectLinks(t.link_json) || [])];
        return tags.length ? tags : undefined;
      })(),
      // FEP-044f: the resolved quoted post (author + content), so the client
      // renders an embedded quote card instead of a bare link. Omitted when the
      // note has no quote or the quoted post could not be resolved.
      'shaer:quote': AP.timelineQuote(t.quote_json),
      // The post author's display info (name / @handle / avatar), so every card
      // gets a byline header like the quote card. attributedTo stays the bare
      // actor URI; this is the resolved presentation Klonkt already stored.
      'shaer:author': (t.author_name || t.author_handle || t.author_icon) ? {
        name: t.author_name || undefined, handle: t.author_handle || undefined,
        icon: t.author_icon || undefined, url: t.author_url || undefined,
        // FEP-9098: emojis in the display name (":shortcode:"), if any.
        emojis: (() => { try { return t.author_emoji_json ? JSON.parse(t.author_emoji_json) : undefined; } catch { return undefined; } })(),
      } : undefined,
      // When a followed account boosted this, who did ("X boosted"). Omitted for
      // ordinary posts.
      'shaer:booster': (t.reblog_name || t.reblog_handle || t.reblog_icon) ? {
        name: t.reblog_name || undefined, handle: t.reblog_handle || undefined,
        icon: t.reblog_icon || undefined,
        // FEP-9098: emojis in the booster's display name (":shortcode:"), if any.
        emojis: (() => { try { return t.reblog_emoji_json ? JSON.parse(t.reblog_emoji_json) : undefined; } catch { return undefined; } })(),
      } : undefined,
      // Whether THIS account already liked/boosted the note, so the app's
      // detail-view buttons show the current state (and can toggle/undo).
      'shaer:liked': !!t.liked,
      'shaer:boosted': !!t.boosted,
      // An external (non-fediverse) embed, thumbnail-only and never an iframe.
      // Omitted entirely when the gate is closed (see above).
      // Carries shaer:playerUrl only when the playback gate is open too.
      'shaer:embed': embedsAllowed ? AP.timelineEmbed(t.embed_json, { playback: playbackAllowed }) : undefined,
    },
  }));
  // The direct notes addressed to this account: a plain DM, a guardian's wave
  // (§5), a ward's 🛟 help request (§5.2.1). Those are messages, not posts, so
  // they are not in the timeline; without them the app's Berichten shows only
  // what you said yourself. Same shape as a post, so one parser handles both.
  const me = AP.actorId(base, auth.site.slug);
  const myHandle = (() => { try { return `@${auth.site.slug}@${new URL(base).host}`; } catch { return `@${auth.site.slug}`; } })();
  const messages = AP.getDirectMessages(auth.site.slug, 60).map((m) => ({
    id: `${m.object_uri}#create`,
    type: 'Create',
    actor: m.actor_uri,
    published: AP.isoStamp(m.published || m.created_at),
    object: {
      id: m.object_uri,
      type: 'Note',
      attributedTo: m.actor_uri,
      content: AP.stripLeadingMentions(m.content),
      url: m.note_url || undefined,
      published: AP.isoStamp(m.published || m.created_at),
      // Addressed to us and to nobody we know of: the other recipients of a
      // note to several people are not ours to see, so we serve what we know.
      to: [me],
      // The Mention is how the client recognises itself as the addressee and
      // groups the note into a conversation. No FEP-e232 link tags here: a
      // mention row keeps the resolved quote, not the raw tags.
      tag: [{ type: 'Mention', href: me, name: myHandle }, ...(AP.timelineEmojis(m.emoji_json) || [])],
      attachment: AP.timelineAttachments(m.media_json),
      // FEP-633c: what kind of message this is. The wave is a gentle nudge from
      // a guardian; the help request is the buoy. Both render differently.
      'shaer:wave': m.wave ? true : undefined,
      'shaer:helpRequest': m.help_request ? true : undefined,
      'shaer:quote': AP.timelineQuote(m.quote_json),
      'shaer:author': (m.actor_name || m.actor_handle || m.actor_icon) ? {
        name: m.actor_name || undefined, handle: m.actor_handle || undefined,
        icon: m.actor_icon || undefined, url: m.actor_url || undefined,
        emojis: (() => { try { return m.actor_emoji_json ? JSON.parse(m.actor_emoji_json) : undefined; } catch { return undefined; } })(),
      } : undefined,
      'shaer:embed': embedsAllowed ? AP.timelineEmbed(m.embed_json, { playback: playbackAllowed }) : undefined,
    },
  }));
  // Inbound REPLIES on your own posts: stored as interactions (the web's
  // comment machinery), never as mentions, so this read missed them and a
  // friend's reply arrived everywhere except in your app (Robins melding,
  // 30-7). Same shape as the other legs; media/quotes ride the stored JSON.
  const replies = AP.getReplyMessages(auth.site.slug, 60).map((m) => ({
    id: `${m.object_uri}#create`,
    type: 'Create',
    actor: m.actor_uri,
    published: AP.isoStamp(m.published || m.created_at),
    object: {
      id: m.object_uri,
      type: 'Note',
      attributedTo: m.actor_uri,
      content: AP.stripLeadingMentions(m.content),
      inReplyTo: m.parent_uri || `${base}/ap/notes/${m.post_id}`,
      published: AP.isoStamp(m.published || m.created_at),
      to: [me],
      tag: [{ type: 'Mention', href: me, name: myHandle }, ...(AP.timelineEmojis(m.emoji_json) || [])],
      attachment: AP.timelineAttachments(m.media_json),
      'shaer:quote': AP.timelineQuote(m.quote_json),
      'shaer:author': (m.actor_name || m.actor_handle || m.actor_icon) ? {
        name: m.actor_name || undefined, handle: m.actor_handle || undefined,
        icon: m.actor_icon || undefined, url: m.actor_url || undefined,
        emojis: (() => { try { return m.actor_emoji_json ? JSON.parse(m.actor_emoji_json) : undefined; } catch { return undefined; } })(),
      } : undefined,
      'shaer:embed': embedsAllowed ? AP.timelineEmbed(m.embed_json, { playback: playbackAllowed }) : undefined,
    },
  }));
  // Your OWN sent notes (replies and direct messages, ap_outbox): without
  // them a reply existed everywhere except in your own app, Messages showed
  // half a conversation, and a retry ran into the duplicate guard (Robins
  // melding, 30-7). Served like the other legs: same shape, one parser.
  const mine = AP.selfAuthor(base, auth.site);
  const sent = AP.getSentNotes(base, auth.site, 60).map((n) => ({
    id: `${n.id}#create`,
    type: 'Create',
    actor: me,
    published: n.published,
    // The leading mention anchor is addressing, not prose (the DM leg strips
    // it the same way); the Mention tags built from the full content stay.
    object: { ...n, content: AP.stripLeadingMentions(n.content), 'shaer:author': mine },
  }));
  // Newest first over all legs, so the app can keep treating this as one feed.
  const items = [...posts, ...messages, ...replies, ...sent].sort((a, b) => String(b.published || '').localeCompare(String(a.published || '')));
  AP.sendAP(res, {
    '@context': AP.AP_CONTEXT,
    id: `${base}/ap/users/${auth.site.slug}/inbox`,
    type: 'OrderedCollection',
    // What this account may do with what is in here (FEP-633c 5.6). Owner-only
    // by construction, and never on the public actor document: it says
    // something about a child, and only the child and its guardians need it.
    'shaer:capabilities': {
      'shaer:externalEmbeds': embedsAllowed,
      'shaer:externalPlayback': playbackAllowed,
      // Leaving the app is the same decision as playing inside it: with the
      // gate shut a link is shown but not followed, so the door is closed too
      // and not just the picture over it.
      'shaer:externalLinks': playbackAllowed,
    },
    totalItems: items.length,
    orderedItems: items,
  });
});

// ── uploadMedia (owner only, AP C2S) ──────────────────────────────
// The actor advertises endpoints.uploadMedia; this implements it. A bearer
// scoped to this site uploads one image/audio/video (multipart field "file",
// AP convention) into the same store the reply editor uses, and gets back
// { url, mediaType, name } to attach on a note (e.g. the help-buoy capture).
const AP_MEDIA_DIR = mediaDir('REPLY_MEDIA_PATH', 'reply-media');
fs.mkdirSync(AP_MEDIA_DIR, { recursive: true });
const AP_MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp3', '.m4a', '.ogg', '.opus', '.flac', '.wav', '.mp4', '.webm', '.mov']);
const apMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, AP_MEDIA_DIR),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || '').toLowerCase()}`),
  }),
  limits: { fileSize: 32 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!AP_MEDIA_EXT.has(ext)) return cb(new Error('Media must be an image, audio or video file'));
    cb(null, true);
  },
});
router.post('/ap/users/:slug/uploadMedia', (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  if (!auth || auth.site.slug !== req.params.slug) return res.status(403).end();
  apMediaUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const mime = String(req.file.mimetype || '');
    if (!/^(image|audio|video)\//.test(mime)) {
      try { fs.unlinkSync(req.file.path); } catch { /* best effort */ }
      return res.status(400).json({ error: 'Media must be an image, audio or video file' });
    }
    // A video gets a poster frame next to it (shaer-zowq), best-effort and
    // out of band: ffmpeg pulls one frame at 1s into <name>.poster.jpg. On a
    // machine without ffmpeg nothing happens and nothing breaks; the clients
    // fall back to extracting a frame natively.
    if (mime.startsWith('video/')) {
      // The bundled static build (ffmpeg-static) does the work, exactly like
      // VideoCoverService and AudioTranscoder already do: Klonkt SHIPS its
      // ffmpeg (Robins opmerking, 30-7), so nothing needs installing on any
      // machine. Soft dependency + best-effort: absent stays silent, and
      // FFMPEG_PATH can still override for an operator who wants a newer one.
      Promise.all([import('child_process'), import('ffmpeg-static')]).then(([{ execFile }, ff]) => {
        const bin = process.env.FFMPEG_PATH || ff.default;
        if (!bin) return;
        const poster = req.file.path + '.poster.jpg';
        execFile(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', req.file.path, '-frames:v', '1', '-vf', "scale='min(640,iw)':-2", poster],
          { timeout: 30000 }, (e) => { if (e && e.code !== 'ENOENT') console.warn('[media] poster failed:', e.message); });
      }).catch(() => { /* never blocks the upload */ });
    }
    // Audio gets the same courtesy (Robins vraag, 30-7: vrolijk de kale
    // audio-tegel op): ffmpeg draws the waveform into <name>.poster.png.
    // White on transparent, so the tile's own gradient stays the backdrop
    // and every audio post keeps its own hue. The shape is bars, not the
    // raw hairy wave (Robins tweede vraag): peak and average sampled into
    // 57 columns (soft tip over bright core), blown up nearest-neighbor to
    // 14px bars, and drawgrid ERASES 5px gaps (c=black@0 + replace=1 writes
    // transparent pixels; h=2*ih keeps horizontal grid lines out of frame).
    if (mime.startsWith('audio/')) {
      Promise.all([import('child_process'), import('ffmpeg-static')]).then(([{ execFile }, ff]) => {
        const bin = process.env.FFMPEG_PATH || ff.default;
        if (!bin) return;
        const poster = req.file.path + '.poster.png';
        const graph = '[0:a]aformat=channel_layouts=mono,asplit[a][b];'
          + '[a]showwavespic=s=57x256:colors=white@0.5:filter=peak:scale=sqrt:draw=full[pk];'
          + '[b]showwavespic=s=57x256:colors=white:filter=average:scale=sqrt:draw=full[av];'
          + '[pk][av]overlay=format=auto,scale=798:256:flags=neighbor,drawgrid=w=14:h=2*ih:t=5:c=black@0:replace=1';
        execFile(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', req.file.path, '-filter_complex', graph, '-frames:v', '1', poster],
          { timeout: 30000 }, (e) => { if (e && e.code !== 'ENOENT') console.warn('[media] waveform failed:', e.message); });
      }).catch(() => { /* never blocks the upload */ });
    }
    res.status(201).json({
      url: '/media/reply-media/' + req.file.filename,
      mediaType: mime,
      name: String(req.file.originalname || '').slice(0, 120),
    });
  });
});

// ── Followers (count-only public, full for the owner) ─────────────
// A C2S bearer scoped to this site (the account owner) gets the real actor
// URIs so their own client can build a friends list; everyone else gets the
// count only (privacy).
// FEP-9876: enrichment is opt-in via `Prefer: return=representation` (RFC 7240).
// Returns true and sets the response headers when the owner asked for it.
function wantsEnriched(req, res) {
  res.set('Vary', 'Prefer');   // enriched and bare are two representations
  if (AP.prefersEnriched(req.get('Prefer'))) {
    res.set('Preference-Applied', 'return=representation');
    return true;
  }
  return false;
}

router.get('/ap/users/:slug/followers', (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  const owner = auth && auth.site.slug === req.params.slug;
  const site = owner ? auth.site : publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  if (owner) {
    const uris = db.prepare('SELECT actor_uri FROM ap_followers WHERE slug = ? ORDER BY created_at').all(site.slug).map((r) => r.actor_uri);
    // Default = bare references; enrich only when the client asks (FEP-9876).
    const items = wantsEnriched(req, res) ? uris.map((u) => AP.buildActorRef(site.slug, u)) : uris;
    return AP.sendAP(res, AP.buildFollowers(baseUrl(req), site, items.length, items));
  }
  const n = db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ?').get(site.slug).n;
  AP.sendAP(res, AP.buildFollowers(baseUrl(req), site, n));
});

// ── Following (count-only public, full for the owner) ─────────────
router.get('/ap/users/:slug/following', (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  const owner = auth && auth.site.slug === req.params.slug;
  const site = owner ? auth.site : publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  if (owner) {
    const enrich = wantsEnriched(req, res);   // FEP-9876 opt-in
    let items = [];
    try {
      const uris = db.prepare("SELECT actor_uri FROM ap_following WHERE slug = ? AND status = 'accepted' ORDER BY created_at").all(site.slug).map((r) => r.actor_uri);
      items = enrich ? uris.map((u) => AP.buildActorRef(site.slug, u)) : uris;
    } catch { /* table may not exist */ }
    return AP.sendAP(res, AP.buildFollowing(baseUrl(req), site, items.length, items));
  }
  let n = 0;
  try { n = db.prepare("SELECT COUNT(*) n FROM ap_following WHERE slug = ? AND status = 'accepted'").get(site.slug).n; } catch { /* table may not exist */ }
  AP.sendAP(res, AP.buildFollowing(baseUrl(req), site, n));
});

// ── Featured (pinned posts → Mastodon "Featured" tab) ─────────────
router.get('/ap/users/:slug/featured', (req, res) => {
  const site = publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  // NB: Mastodon DISPLAYS the featured collection in REVERSE (pins shown
  // last-processed-first). So we emit it reversed (lowest pin priority first,
  // rank 1 last) → Mastodon flips it back to pin-rank ascending on the profile.
  const posts = db.prepare(
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, c2s_attachments, published_at, created_at
     FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
       AND pinned IS NOT NULL AND pinned > 0
     ORDER BY pinned DESC, COALESCE(published_at, created_at) ASC LIMIT 20`
  ).all(site.id);
  AP.sendAP(res, AP.buildFeatured(baseUrl(req), site, posts));
});

// ── Note ──────────────────────────────────────────────────────────
router.get('/ap/notes/:id', async (req, res) => {
  // No fan_only filter in the SELECT anymore: a friends-only post is not
  // absent, it is GATED. The old route hid it from EVERYONE, also from the
  // follower whose friendship earns it — so the signed resolution the reply
  // path performs knocked on a door that could never open, and every reply
  // to a friends-only post (Shaer's default!) died in
  // cannot_resolve_inReplyTo. Strangers still get the exact same 404, so a
  // note's existence stays as private as before.
  const post = db.prepare(
    "SELECT * FROM posts WHERE id = ? AND status = 'published'"
  ).get(req.params.id);
  if (post && AP.noteAudience(post) !== 'public') {
    // The whole gate in a try: this is the only async route in this file,
    // and Express 4 does not catch an async rejection — the request would
    // hang forever instead of failing (which is exactly how the missing
    // default-export entry manifested while building this). Any error here
    // reads as "not authorized", never as silence.
    try {
      if (AP.noteAudience(post) === 'direct') return res.status(404).end();
      const gsite = db.prepare('SELECT * FROM sites WHERE id = ?').get(post.site_id);
      const actor = await AP.verifyRequest(req).catch(() => null);
      if (!actor || !AP.mayReadNote(gsite, post, actor.id)) return res.status(404).end();
    } catch { return res.status(404).end(); }
  }
  if (!post) {
    // Could be one of OUR outbound replies (ap_outbox), not a post.
    const note = AP.getOutboxNote(baseUrl(req), req.params.id);
    if (!note) return res.status(404).end();
    if (!AP.apWants(req)) {
      // A browser hit a reply's AP URL → send them to the source it replies to
      // (where the post + its reactions live), falling back to the site home.
      const src = (typeof note.inReplyTo === 'string' && /^https?:\/\//i.test(note.inReplyTo))
        ? note.inReplyTo : (baseUrl(req) + '/');
      return res.redirect(302, src);
    }
    return AP.sendAP(res, { '@context': AP.AP_CONTEXT, ...note });
  }
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(post.site_id);
  if (!site) return res.status(404).end();
  const note = AP.buildNote(baseUrl(req), site, post);
  if (!AP.apWants(req)) {
    // A browser hit a post's AP note URL → send them to the human post page
    // (which shows the post + its "from the fediverse" reactions).
    return res.redirect(302, note.url || (baseUrl(req) + '/'));
  }
  AP.sendAP(res, { '@context': AP.AP_CONTEXT, ...note });
});

// ── Replies collection ── lets remote servers fetch a post's whole thread.
router.get('/ap/notes/:id/replies', (req, res) => {
  const base = baseUrl(req);
  const items = AP.getReplyUris(base, req.params.id);
  AP.sendAP(res, {
    '@context': AP.AP_CONTEXT,
    id: `${base}/ap/notes/${req.params.id}/replies`,
    type: 'OrderedCollection',
    totalItems: items.length,
    orderedItems: items,
  });
});

// ── NodeInfo ── standard instance metadata so fediverse tools recognise Klonkt.
router.get('/.well-known/nodeinfo', (req, res) => {
  res.type('application/json');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(JSON.stringify({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1', href: `${baseUrl(req)}/nodeinfo/2.1` }] }));
});
router.get('/nodeinfo/2.1', (req, res) => {
  let users = 0; let posts = 0;
  // "users" = public AP actors (sites), not the admin/member account rows.
  try { users = db.prepare('SELECT COUNT(*) c FROM sites WHERE (is_public IS NULL OR is_public = 1)').get().c; } catch { /* */ }
  try { posts = db.prepare("SELECT COUNT(*) c FROM posts WHERE status = 'published'").get().c; } catch { /* */ }
  res.type('application/json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  res.send(JSON.stringify({
    version: '2.1',
    software: { name: 'klonkt', version: _ver, repository: 'https://github.com/roboburr/klonkt' },
    protocols: ['activitypub'],
    services: { inbound: [], outbound: [] },
    openRegistrations: false,
    usage: { users: { total: users }, localPosts: posts },
    metadata: { nodeName: 'Klonkt' },
  }));
});

// ── Inbox — Follow→Accept, Undo Follow (best-effort signature verify) ──
const apJson = express.json({
  type: ['application/activity+json', 'application/ld+json', 'application/json'],
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf; }, // raw body for digest verification
});
router.post(['/ap/users/:slug/inbox', '/ap/inbox'], apInboxLimiter, apJson, async (req, res) => {
  try { return res.status(await AP.handleInbox(req, req.params.slug || null) || 202).end(); }
  catch (e) { console.warn('[AP inbox] error:', e.message); return res.status(202).end(); }
});

// ── Outbox POST: ActivityPub Client-to-Server ─────────────────────
// A bearer-authenticated client (Shaer) POSTs an activity; we translate it onto
// the normal delivery machinery. The token is scoped to one user+site (OAuth
// consent), so it must match the slug in the URL. (Declared after apJson, which
// this shares with the inbox handler.)
router.post('/ap/users/:slug/outbox', apInboxLimiter, apJson, async (req, res) => {
  const auth = OAuth.verifyBearer(req.headers.authorization);
  if (!auth) { res.set('WWW-Authenticate', 'Bearer'); return res.status(401).json({ error: 'invalid_token' }); }
  if (auth.site.slug !== req.params.slug) return res.status(403).json({ error: 'wrong_site', detail: 'token is scoped to a different site' });
  if (auth.user.readonly) return res.status(403).json({ error: 'read_only_account' });

  const out = await AP.ingestOutboxActivity(auth.site, auth.user, req.body);
  if (out.error) return res.status(out.status || 400).json({ error: out.error, detail: out.detail });
  // 201 Created → Location header (AP spec); 202 Accepted for side-effect verbs.
  if (out.status === 201 && out.url) res.set('Location', out.url);
  // `state` carries a third outcome the app must be able to tell apart from a
  // plain success: a ward's follow held for its guardians (§5.3, shaer-p729).
  return res.status(out.status || 202).json({ ok: true, id: out.id, url: out.url, ...(out.state ? { state: out.state } : {}) });
});

export default router;
