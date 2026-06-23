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
import { getTenancy } from '../services/SettingsService.js';

const router = express.Router();

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
router.get('/cirkel', (req, res, next) => {
  if (getTenancy() !== 'circle') return next();

  const rows = db.prepare(`
    SELECT p.id, p.published, p.title, p.summary, p.media_json, p.tags,
           a.name AS actor_name
    FROM remote_posts p
    JOIN remote_actors a ON a.id = p.actor_id
    ORDER BY COALESCE(p.published, p.fetched_at) DESC
    LIMIT 100
  `).all();

  const posts = rows.map((r) => {
    const image = mediaImage(r.media_json);
    return {
      id: r.id,
      // Local reading page -> the card stays on the own site (post-card links
      // locally + htmx, NO external_url).
      slug: 'cirkel/' + encodeURIComponent(r.id),
      title: r.title || '(zonder titel)',
      excerpt: r.summary || '',
      cover_image_url: image ? image.url : null,
      published_at: r.published,
      created_at: r.published,
      type: 'post',
      tags: r.tags || '',
      pinned: 0,
      status: 'published',
      source_name: r.actor_name || 'Onbekend',
    };
  });

  // Sites in the circle — active links only (outdated/error ones are excluded, along
  // with their posts). Used for the graphic header with avatars.
  const sites = db.prepare(`
    SELECT a.name, a.url, a.avatar
    FROM remote_actors a
    JOIN circle_links l ON l.remote_actor_id = a.id
    WHERE l.status = 'active'
    ORDER BY a.name
  `).all()
    .map((s) => ({
      name: s.name || 'Onbekend',
      url: safeUrl(s.url),
      avatar: safeUrl(s.avatar),
    }));

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
