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

// 'kijker' = read-only demo/audit account: may view everything (incl. admin panel),
// but the global guard blocks all mutations. Replaces the old separate
// 'kijk-modus' flag (readonly), which is now covered by this role.
const VALID_ROLES = new Set(['kijker', 'member', 'admin', 'god']);

function godCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'god'").get().c;
}

// ==================== LIST ====================
router.get('/', requireGod, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.created_at, u.avatar_url, u.readonly,
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

  // readonly=0: read-only status now lives entirely in the 'kijker' role, so
  // on every role change we clear the legacy flag (no dual source of truth).
  db.prepare('UPDATE users SET role = ?, readonly = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
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

  // Cascade delete: this user's sites (+ posts/playlists/audio/members/
  // comments under them), their own content elsewhere, then the user themselves.
  // Atomic in a transaction — if any FK fails, everything rolls back.
  const del = db.transaction(() => {
    const sites = db.prepare('SELECT id FROM sites WHERE owner_id = ?').all(userId).map((s) => s.id);
    for (const sid of sites) {
      db.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE site_id = ?)').run(sid);
      db.prepare('DELETE FROM posts WHERE site_id = ?').run(sid);
      db.prepare('DELETE FROM playlists WHERE site_id = ?').run(sid);
      db.prepare('DELETE FROM audio_tracks WHERE site_id = ?').run(sid);
      db.prepare('DELETE FROM site_members WHERE site_id = ?').run(sid);
      db.prepare('DELETE FROM sites WHERE id = ?').run(sid);
    }
    // Own content on other sites + loose associations.
    db.prepare('DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)').run(userId);
    db.prepare('DELETE FROM posts WHERE author_id = ?').run(userId);
    db.prepare('DELETE FROM comments WHERE author_id = ?').run(userId);
    db.prepare('DELETE FROM site_members WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });

  try {
    del();
  } catch (e) {
    console.error('[admin/users delete]', e.message);
    return res.redirect('/admin/users?error=' + encodeURIComponent('Verwijderen mislukt (mogelijk gekoppelde data).'));
  }

  res.redirect('/admin/users?success=' + encodeURIComponent('Gebruiker verwijderd: ' + target.username));
});

export default router;
