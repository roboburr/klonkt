/**
 * Comments — phase G v1.
 *
 * POST /comments              -> create a comment on a post (auth required)
 * POST /comments/:id/delete   -> delete (own, or god/site-admin)
 *
 * Threading: 1 level deep (top-level + replies). Replies-of-replies fold up
 * into the same parent (UI keeps it shallow).
 *
 * Status: auto-approved for logged-in users (trust mode). The schema's
 * `status` column stays so we can switch to moderation later without changing
 * shape. Anonymous comments (require_login_to_comment = 0 + no user) come
 * later — for now we always require login.
 */

import express from 'express';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import PermissionsService from '../services/PermissionsService.js';

const router = express.Router();

// Limits
const MAX_LEN = 4000;
const MIN_LEN = 1;

router.post('/', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const postSlug = (req.body.post_slug || '').trim();
  const rawContent = (req.body.content || '').trim();
  const parentId = (req.body.parent_comment_id || '').trim() || null;

  if (!postSlug) return res.status(400).send('post_slug required');
  if (rawContent.length < MIN_LEN) return res.status(400).send('Comment cannot be empty');
  if (rawContent.length > MAX_LEN) return res.status(413).send(`Comment too long (max ${MAX_LEN} chars)`);

  const post = db.prepare(
    'SELECT id, slug FROM posts WHERE site_id = ? AND slug = ? AND status = ?'
  ).get(site.id, postSlug, 'published');
  if (!post) return res.status(404).send('Post not found');

  if (!PermissionsService.canComment(req.session.user, site, post)) {
    return res.status(403).send('Comments not allowed');
  }

  // Validate parent (must belong to this post; collapses replies-of-replies
  // up to the top-level parent so we never go deeper than 1)
  let resolvedParent = null;
  if (parentId) {
    const parent = db.prepare(
      'SELECT id, parent_comment_id FROM comments WHERE id = ? AND post_id = ?'
    ).get(parentId, post.id);
    if (!parent) return res.status(400).send('Invalid parent comment');
    resolvedParent = parent.parent_comment_id || parent.id;
  }

  // Status depends on the site's moderation mode.
  // 'trust'    = auto-approve immediately (default).
  // 'moderate' = pending until an admin reviews in /admin/comments.
  // Author is the post author or god → always trusted (no point gatekeeping yourself).
  const isTrustedAuthor = req.session.user.role === 'god'
    || req.session.user.id === post.author_id;
  const status = (site.comments_moderation_mode === 'moderate' && !isTrustedAuthor)
    ? 'pending'
    : 'approved';

  const commentId = uuid();
  db.prepare(`
    INSERT INTO comments (id, post_id, author_id, parent_comment_id, content, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(commentId, post.id, req.session.user.id, resolvedParent, rawContent, status);

  // Where to land after submit:
  //   approved → scroll to the new comment
  //   pending  → comments anchor + ?pending=1 query so post page can flash a notice
  const target = status === 'approved'
    ? `${res.locals.siteUrlBase || ''}/${post.slug}#comment-${commentId}`
    : `${res.locals.siteUrlBase || ''}/${post.slug}?pending=1#comments`;
  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', target);
    return res.send('OK');
  }
  res.redirect(target);
});

router.post('/:id/delete', requireAuth, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');

  const comment = db.prepare(`
    SELECT c.id, c.author_id, c.post_id, p.slug AS post_slug
    FROM comments c JOIN posts p ON p.id = c.post_id
    WHERE c.id = ? AND p.site_id = ?
  `).get(req.params.id, site.id);

  if (!comment) return res.status(404).send('Not found');
  if (!PermissionsService.canDeleteComment(req.session.user, comment, site)) {
    return res.status(403).send('No permission');
  }

  // Delete the comment plus any replies that hung off it
  db.prepare('DELETE FROM comments WHERE id = ? OR parent_comment_id = ?')
    .run(req.params.id, req.params.id);

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', `${res.locals.siteUrlBase || ''}/${comment.post_slug}#comments`);
    return res.send('OK');
  }
  res.redirect(`${res.locals.siteUrlBase || ''}/${comment.post_slug}#comments`);
});

export default router;
