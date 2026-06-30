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
const primarySlug = () => { const r = db.prepare('SELECT slug FROM sites WHERE is_primary = 1').get(); return r && r.slug; };

// ── WebFinger ─────────────────────────────────────────────────────
router.get('/.well-known/webfinger', (req, res) => {
  const m = String(req.query.resource || '').match(/^acct:([^@]+)@(.+)$/i);
  if (!m) return res.status(400).type('text/plain').send('bad resource');
  const site = publicSite(m[1]);
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
router.get('/ap/users/:slug/outbox', (req, res) => {
  const site = publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  const posts = db.prepare(
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, published_at, created_at
     FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 20`
  ).all(site.id);
  AP.sendAP(res, AP.buildOutbox(baseUrl(req), site, posts));
});

// ── Followers (count only) ────────────────────────────────────────
router.get('/ap/users/:slug/followers', (req, res) => {
  const site = publicSite(req.params.slug);
  if (!site) return res.status(404).end();
  const n = db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ?').get(site.slug).n;
  AP.sendAP(res, AP.buildFollowers(baseUrl(req), site, n));
});

// ── Following (count only) ────────────────────────────────────────
router.get('/ap/users/:slug/following', (req, res) => {
  const site = publicSite(req.params.slug);
  if (!site) return res.status(404).end();
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
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, published_at, created_at
     FROM posts WHERE site_id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)
       AND pinned IS NOT NULL AND pinned > 0
     ORDER BY pinned DESC, COALESCE(published_at, created_at) ASC LIMIT 20`
  ).all(site.id);
  AP.sendAP(res, AP.buildFeatured(baseUrl(req), site, posts));
});

// ── Note ──────────────────────────────────────────────────────────
router.get('/ap/notes/:id', (req, res) => {
  const post = db.prepare(
    "SELECT * FROM posts WHERE id = ? AND status = 'published' AND (fan_only IS NULL OR fan_only = 0)"
  ).get(req.params.id);
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

export default router;
