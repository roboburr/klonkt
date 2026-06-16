/**
 * Publieke Cirkel-feed: /cirkel
 * Toont de gecachte publieke posts uit je cirkel als statische kaarten.
 * Alleen actief als tenancy === 'circle' (anders next() -> postsRoutes/404).
 * Zie docs/cirkels-v1-spec.md §5c.
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

router.get('/cirkel', (req, res, next) => {
  if (getTenancy() !== 'circle') return next();

  const rows = db.prepare(`
    SELECT p.id, p.published, p.title, p.summary, p.url, p.media_json,
           a.name AS actor_name, a.url AS actor_url, a.avatar AS actor_avatar
    FROM remote_posts p
    JOIN remote_actors a ON a.id = p.actor_id
    ORDER BY COALESCE(p.published, p.fetched_at) DESC
    LIMIT 100
  `).all();

  const posts = rows.map((r) => {
    const media = safeJson(r.media_json)
      .map((m) => ({ ...m, url: safeUrl(m.url) }))
      .filter((m) => m.url);
    const image = media.find((m) => m.type === 'image') || null;
    return {
      id: r.id,
      title: r.title || '(zonder titel)',
      summary: r.summary || '',
      url: safeUrl(r.url),
      published: r.published,
      actorName: r.actor_name || 'Onbekend',
      actorUrl: safeUrl(r.actor_url),
      actorAvatar: safeUrl(r.actor_avatar),
      image: image ? image.url : null,
    };
  });

  renderPage(req, res, 'pages/circle-feed', { pageTitle: 'Cirkel', posts });
});

export default router;
