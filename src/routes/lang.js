// Visitor language choice: /lang/:code sets the interface language in the session
// and redirects back to where you came from. (Content stays in the author's language.)
import express from 'express';
import { SUPPORTED } from '../services/i18n.js';
import db from '../config/database.js';

const router = express.Router();

router.get('/lang/:code', (req, res) => {
  const code = SUPPORTED.includes(req.params.code) ? req.params.code : 'nl';
  if (req.session) req.session.lang = code;
  // Logged in? Also save the choice on the account so it follows the user
  // across devices/sessions (not just this session cookie).
  if (req.session && req.session.user && req.session.user.id) {
    try {
      db.prepare('UPDATE users SET lang = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(code, req.session.user.id);
      req.session.user.lang = code;
    } catch { /* lang column missing on an old DB → session-only, no breakage */ }
  }
  // Safe back URL: internal path only (no open redirect).
  let back = (typeof req.query.r === 'string') ? req.query.r : '';
  if (!back.startsWith('/') || back.startsWith('//')) {
    try {
      const u = new URL(req.get('referer') || '');
      back = u.pathname + (u.search || '');
    } catch { back = '/'; }
  }
  res.redirect(back || '/');
});

export default router;
