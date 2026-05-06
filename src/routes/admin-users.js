/**
 * Admin: User management — Phase E.
 *
 * GET  /admin/users               -> list users
 * POST /admin/users/:id/role      -> change role (member/admin/god)
 * POST /admin/users/:id/delete    -> delete (refused if user has owned content)
 *
 * Safety rules:
 *  - The system always keeps at least 1 god (you can't demote/delete the last one).
 *  - You can't change your OWN role to non-god (avoid locking yourself out).
 *  - Delete is refused if the user owns any sites or has any posts.
 *    Leaves it to god to reassign content first.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';

const router = express.Router();

const VALID_ROLES = new Set(['member', 'admin', 'god']);

function godCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'god'").get().c;
}

// ==================== LIST ====================
router.get('/', requireGod, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.created_at, u.avatar_url,
           (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS post_count,
           (SELECT COUNT(*) FROM sites s  WHERE s.owner_id  = u.id) AS site_count
    FROM users u
    ORDER BY u.created_at DESC
  `).all();

  renderPage(req, res, 'pages/admin-users', {
    pageTitle: 'Users',
    bodyClass: 'on-admin',
    users,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// ==================== CHANGE ROLE ====================
router.post('/:id/role', requireGod, (req, res) => {
  const userId = req.params.id;
  const newRole = (req.body.role || '').toString();
  if (!VALID_ROLES.has(newRole)) {
    return res.redirect('/admin/users?error=Invalid+role');
  }

  const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!target) return res.redirect('/admin/users?error=User+not+found');

  // Prevent self-demotion away from god (lock-out protection)
  if (target.id === req.session.user.id && newRole !== 'god') {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot demote yourself'));
  }

  // Prevent removing the last god
  if (target.role === 'god' && newRole !== 'god' && godCount() <= 1) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot demote the only remaining god'));
  }

  db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newRole, userId);
  res.redirect('/admin/users?success=' + encodeURIComponent('Role updated'));
});

// ==================== DELETE ====================
router.post('/:id/delete', requireGod, (req, res) => {
  const userId = req.params.id;
  const target = db.prepare('SELECT id, role, username FROM users WHERE id = ?').get(userId);
  if (!target) return res.redirect('/admin/users?error=User+not+found');

  if (target.id === req.session.user.id) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot delete yourself'));
  }
  if (target.role === 'god' && godCount() <= 1) {
    return res.redirect('/admin/users?error=' + encodeURIComponent('Cannot delete the only remaining god'));
  }

  const owned = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM posts WHERE author_id = ?) AS posts,
      (SELECT COUNT(*) FROM sites WHERE owner_id  = ?) AS sites
  `).get(userId, userId);

  if (owned.posts > 0 || owned.sites > 0) {
    return res.redirect('/admin/users?error=' + encodeURIComponent(
      `Cannot delete: user owns ${owned.sites} site(s) and ${owned.posts} post(s). Reassign or delete those first.`
    ));
  }

  // Clean up dangling references
  db.prepare('DELETE FROM site_members WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM comments WHERE author_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  res.redirect('/admin/users?success=' + encodeURIComponent('User deleted: ' + target.username));
});

export default router;
