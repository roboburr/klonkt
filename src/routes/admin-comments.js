/**
 * Admin: Comment moderation queue — Phase E.
 *
 * GET  /admin/comments              -> list pending + recent (god-only)
 * POST /admin/comments/:id/approve  -> set status = 'approved'
 * POST /admin/comments/:id/reject   -> set status = 'rejected' (keeps the row
 *                                      so we have a paper trail; admin can
 *                                      hard-delete via the post page).
 *
 * Scope: shows comments for the resolved site only (the one matched by
 * /sites/:slug or default). Future: filter by status / search.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireSiteManager } from '../middleware/auth.js';

const router = express.Router();

router.get('/', requireSiteManager, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const pending = db.prepare(`
    SELECT c.id, c.content, c.created_at, c.parent_comment_id,
           u.username AS author_username,
           p.slug AS post_slug, p.title AS post_title
    FROM comments c
    JOIN users u ON u.id = c.author_id
    JOIN posts p ON p.id = c.post_id
    WHERE p.site_id = ? AND c.status = 'pending'
    ORDER BY c.created_at ASC
    LIMIT 200
  `).all(site.id);

  const recent = db.prepare(`
    SELECT c.id, c.content, c.created_at, c.status,
           u.username AS author_username,
           p.slug AS post_slug, p.title AS post_title
    FROM comments c
    JOIN users u ON u.id = c.author_id
    JOIN posts p ON p.id = c.post_id
    WHERE p.site_id = ? AND c.status IN ('approved', 'rejected')
    ORDER BY c.created_at DESC
    LIMIT 30
  `).all(site.id);

  renderPage(req, res, 'pages/admin-comments', {
    pageTitle: 'Comment moderation',
    bodyClass: 'on-admin',
    pending,
    recent,
    moderationMode: site.comments_moderation_mode || 'trust',
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

function setStatus(req, res, status) {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');
  const base = res.locals.siteUrlBase || ''; // /user/<slug> in hub-artiestcontext, anders ''

  const row = db.prepare(`
    SELECT c.id FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE c.id = ? AND p.site_id = ?
  `).get(req.params.id, site.id);

  if (!row) return res.redirect(base + '/admin/comments?error=Not+found');

  db.prepare(
    'UPDATE comments SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(status, req.params.id);
  res.redirect(base + '/admin/comments?success=' + encodeURIComponent('Comment ' + status));
}

router.post('/:id/approve', requireSiteManager, (req, res) => setStatus(req, res, 'approved'));
router.post('/:id/reject',  requireSiteManager, (req, res) => setStatus(req, res, 'rejected'));

export default router;
