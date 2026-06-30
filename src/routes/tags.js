/**
 * GET /tag/:tag
 *
 * Lists published posts on the current site that contain :tag in their
 * tags JSON array. Uses SQLite's json_each() to expand the array.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';

const router = express.Router();

router.get('/:tag', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const tag = (req.params.tag || '').trim();
  if (!tag) return res.redirect(res.locals.siteUrlBase || '/');

  let posts = [];
  try {
    posts = db.prepare(`
      SELECT DISTINCT p.id, p.slug, p.title, p.excerpt, p.cover_image_url, p.cover_video_url,
                      p.published_at, u.username AS author_username
      FROM posts p, json_each(p.tags) j
      JOIN users u ON u.id = p.author_id
      WHERE p.site_id = ?
        AND p.status = 'published'
        AND j.value = ?
      ORDER BY p.published_at DESC
      LIMIT 100
    `).all(site.id, tag);
  } catch (e) {
    // Fall back to a LIKE match if json_each isn't available for some reason
    posts = db.prepare(`
      SELECT p.id, p.slug, p.title, p.excerpt, p.cover_image_url, p.cover_video_url,
             p.published_at, u.username AS author_username
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.site_id = ?
        AND p.status = 'published'
        AND p.tags LIKE ?
      ORDER BY p.published_at DESC
      LIMIT 100
    `).all(site.id, `%"${tag}"%`);
  }

  renderPage(req, res, 'pages/tag', {
    pageTitle: `#${tag} — ${site.title}`,
    bodyClass: 'on-special',
    tag,
    posts,
  });
});

export default router;
