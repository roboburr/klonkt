/**
 * GET /type/:type
 *
 * Lists published posts on the current site filtered by post.type.
 * Mirrors the v9 /type/ pages (foto, video, audio, post).
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';

const router = express.Router();
const VALID_TYPES = new Set(['post', 'foto', 'video', 'audio']);

router.get('/:type', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const type = (req.params.type || '').toLowerCase().trim();
  if (!VALID_TYPES.has(type)) return res.status(404).send('Unknown type');

  const posts = db.prepare(`
    SELECT p.id, p.slug, p.title, p.excerpt, p.cover_image_url,
           p.published_at, p.type, u.username AS author_username
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.site_id = ? AND p.status = 'published' AND p.type = ?
    ORDER BY p.published_at DESC
    LIMIT 100
  `).all(site.id, type);

  renderPage(req, res, 'pages/type', {
    pageTitle: type[0].toUpperCase() + type.slice(1) + ' — ' + site.title,
    bodyClass: 'on-special',
    type,
    posts,
  });
});

export default router;
