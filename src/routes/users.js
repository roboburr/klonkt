/**
 * GET /users/:username
 *
 * Author profile page: shows the user + their published posts on the
 * current site. Read-only. Honours v9-style URL pattern.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';

const router = express.Router();

router.get('/:username', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const username = (req.params.username || '').trim();
  if (!username) return res.status(404).send('Not found');

  const author = db.prepare(`
    SELECT id, username, bio, avatar_url, role, palette, theme, created_at
    FROM users WHERE username = ?
  `).get(username);

  if (!author) return res.status(404).send('User not found');

  const posts = db.prepare(`
    SELECT p.id, p.slug, p.title, p.excerpt, p.cover_image_url, p.cover_video_url, p.published_at
    FROM posts p
    WHERE p.author_id = ? AND p.site_id = ? AND p.status = 'published'
    ORDER BY p.published_at DESC
    LIMIT 100
  `).all(author.id, site.id);

  // Total across all sites — useful context, doesn't leak content
  const totalPosts = db.prepare(`
    SELECT COUNT(*) AS c FROM posts WHERE author_id = ? AND status = 'published'
  `).get(author.id).c;

  renderPage(req, res, 'pages/user', {
    pageTitle: `${author.username} — ${site.title}`,
    bodyClass: 'on-special',
    author,
    posts,
    totalPosts,
  });
});

export default router;
