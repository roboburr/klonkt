/**
 * Circle feed + local reading page.
 *   GET /cirkel        -> overview (same timeline/grid view as the home)
 *   GET /cirkel/:id    -> individual remote post in own chrome (stay on your site)
 * Only active when tenancy === 'circle' (otherwise next() -> postsRoutes/404).
 * See docs/cirkels-v1-spec.md §5c.
 */

import express from 'express';
import { renderPage } from '../middleware/render.js';
import db from '../config/database.js';
import { getTenancy, apEnabled } from '../services/SettingsService.js';
import ActivityPubService from '../services/ActivityPubService.js';

const router = express.Router();

function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}
function safeJson(s) {
  try { return s ? JSON.parse(s) : []; } catch { return []; }
}
function mediaImage(media_json) {
  const media = safeJson(media_json).map((m) => ({ ...m, url: safeUrl(m.url) })).filter((m) => m.url);
  return media.find((m) => m.type === 'image') || null;
}

// ── Overview ─────────────────────────────────────────────────
// New model: the Cirkel = posts from the accounts this site auto-boosts
// ("feature an artist"), sourced from ActivityPub. Cards link to the source
// post (external_url). Legacy circle-tenancy remote_posts are merged in until
// the old pull-protocol is removed (Phase 4).
router.get('/cirkel', (req, res, next) => {
  const site = res.locals.site;
  if (!site) return next();
  const slug = site.slug;
  const isCircle = getTenancy() === 'circle';
  const abCount = apEnabled() ? ActivityPubService.autoBoostCount(slug) : 0;
  if (!abCount && !isCircle) return next(); // no cirkel on this site

  let posts = [];

  // Featured (auto-boosted) fediverse posts → link to the original.
  if (abCount) {
    posts = ActivityPubService.getCirkelPosts(slug, 80).map((r) => {
      const text = htmlToText(r.content);
      const image = mediaImage(r.media_json);
      const name = r.author_name || r.author_handle || 'Onbekend';
      return {
        id: 'ap-' + r.id,
        slug: '',
        title: text ? (text.length > 90 ? text.slice(0, 90) + '…' : text) : name,
        excerpt: '',
        cover_image_url: image ? image.url : null,
        published_at: r.published,
        created_at: r.published,
        type: 'post',
        tags: '',
        pinned: 0,
        status: 'published',
        source_name: name,
        external_url: safeUrl(r.url),
      };
    });
  }

  // Legacy circle-tenancy remote_posts (local reading page, no external_url).
  if (isCircle) {
    const rows = db.prepare(`
      SELECT p.id, p.published, p.title, p.summary, p.media_json, p.tags, a.name AS actor_name
      FROM remote_posts p JOIN remote_actors a ON a.id = p.actor_id
      ORDER BY COALESCE(p.published, p.fetched_at) DESC LIMIT 100
    `).all().map((r) => {
      const image = mediaImage(r.media_json);
      return {
        id: r.id, slug: 'cirkel/' + encodeURIComponent(r.id),
        title: r.title || '(zonder titel)', excerpt: r.summary || '',
        cover_image_url: image ? image.url : null, published_at: r.published, created_at: r.published,
        type: 'post', tags: r.tags || '', pinned: 0, status: 'published', source_name: r.actor_name || 'Onbekend',
      };
    });
    posts = posts.concat(rows);
  }

  posts.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')));

  // Members header (avatars): featured artists + legacy circle links.
  let sites = abCount
    ? ActivityPubService.getCirkelMembers(slug).map((s) => ({ name: s.name || 'Onbekend', url: safeUrl(s.url), avatar: safeUrl(s.icon) }))
    : [];
  if (isCircle) {
    const old = db.prepare(`
      SELECT a.name, a.url, a.avatar FROM remote_actors a
      JOIN circle_links l ON l.remote_actor_id = a.id WHERE l.status = 'active' ORDER BY a.name
    `).all().map((s) => ({ name: s.name || 'Onbekend', url: safeUrl(s.url), avatar: safeUrl(s.avatar) }));
    sites = sites.concat(old);
  }

  renderPage(req, res, 'pages/circle-feed', { pageTitle: 'Cirkel', bodyClass: 'on-cirkel', posts, sites });
});

// ── Individual remote post (local reading) ────────────────────
router.get('/cirkel/:id', (req, res, next) => {
  if (getTenancy() !== 'circle') return next();

  const row = db.prepare(`
    SELECT p.id, p.published, p.title, p.summary, p.url, p.media_json, p.tags,
           a.name AS actor_name, a.url AS actor_url, a.avatar AS actor_avatar
    FROM remote_posts p
    JOIN remote_actors a ON a.id = p.actor_id
    WHERE p.id = ?
  `).get(req.params.id);

  if (!row) return next();

  const image = mediaImage(row.media_json);
  const post = {
    title: row.title || '(zonder titel)',
    body: row.summary || '',          // platte tekst (gesanitized bij ingest)
    published: row.published,
    image: image ? image.url : null,
    sourceName: row.actor_name || 'Onbekend',
    sourceUrl: safeUrl(row.actor_url),
    sourceAvatar: safeUrl(row.actor_avatar),
    originalUrl: safeUrl(row.url),
    tags: (row.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    sourceTagBase: safeUrl(row.actor_url) ? safeUrl(row.actor_url).replace(/\/+$/, '') : null,
  };

  renderPage(req, res, 'pages/circle-post', {
    pageTitle: post.title,
    bodyClass: 'on-cirkel-post',
    post,
  });
});

export default router;
