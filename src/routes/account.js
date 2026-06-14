/**
 * Account routes — profile, password, avatar.
 *
 * Sections:
 *   GET  /                  -> render full account page (profile + password + avatar + danger)
 *   POST /profile           -> update bio
 *   POST /password          -> change password (verify current, hash new)
 *   POST /avatar            -> upload avatar image (multer)
 *   POST /avatar/remove     -> clear avatar_url
 *
 * Each form has its own POST handler. After success, redirects back to
 * /account?success=... so the page picks it up via query string.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireAuth } from '../middleware/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AVATAR_DIR = path.resolve(
  process.env.AVATAR_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'avatars')
);
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_AVATAR_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuid()}${ext}`);
  },
});
const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: MAX_AVATAR_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_AVATAR_EXT.has(ext)) {
      return cb(new Error('Avatar must be jpg/png/webp/gif'));
    }
    cb(null, true);
  },
});

const router = express.Router();

// ==================== GET account page ====================
router.get('/', requireAuth, (req, res) => {
  const account = db.prepare(`
    SELECT id, username, email, role, bio, avatar_url, created_at, password_hash
    FROM users WHERE id = ?
  `).get(req.session.user.id);
  const hasPassword = !!(account && account.password_hash && account.password_hash !== '!google-oauth');
  if (account) delete account.password_hash; // niet naar de view lekken

  renderPage(req, res, 'pages/account', {
    pageTitle: 'Account',
    bodyClass: 'on-special',
    account,
    hasPassword,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// ==================== UPDATE BIO ====================
router.post('/profile', requireAuth, (req, res) => {
  const bio = (req.body.bio || '').toString().slice(0, 500).trim();
  db.prepare('UPDATE users SET bio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(bio || null, req.session.user.id);
  res.redirect('/account?success=' + encodeURIComponent('Profile updated'));
});

// P57 — /preferences route removed. Per-user theme/palette was a multi-tenant
// holdover that conflicts with the site-default model: visitors should see
// the site's appearance, not whatever a user once picked. The users.theme and
// users.palette columns stay in the schema (no migration needed) but are no
// longer read or written.

// ==================== CHANGE PASSWORD ====================
router.post('/password', requireAuth, (req, res) => {
  const { current, new_password, confirm } = req.body;
  if (!current || !new_password || !confirm) {
    return res.redirect('/account?error=' + encodeURIComponent('Alle wachtwoordvelden zijn verplicht'));
  }
  if (new_password.length < 8) {
    return res.redirect('/account?error=' + encodeURIComponent('Nieuw wachtwoord moet minstens 8 tekens zijn'));
  }
  if (new_password !== confirm) {
    return res.redirect('/account?error=' + encodeURIComponent('Nieuwe wachtwoorden komen niet overeen'));
  }

  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.user.id);
  // Google-only accounts (luisteraars) hebben geen echt wachtwoord.
  if (!row || !row.password_hash || row.password_hash === '!google-oauth') {
    return res.redirect('/account?error=' + encodeURIComponent('Dit account heeft geen wachtwoord (Google-login)'));
  }
  if (!bcrypt.compareSync(current, row.password_hash)) {
    return res.redirect('/account?error=' + encodeURIComponent('Huidig wachtwoord is onjuist'));
  }

  const newHash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newHash, req.session.user.id);

  res.redirect('/account?success=' + encodeURIComponent('Wachtwoord gewijzigd'));
});

// ==================== UPLOAD AVATAR ====================
router.post('/avatar', requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, (err) => {
    if (err) {
      return res.redirect('/account?error=' + encodeURIComponent(err.message));
    }
    if (!req.file) {
      return res.redirect('/account?error=' + encodeURIComponent('No file uploaded'));
    }

    const url = `/media/avatars/${req.file.filename}`;

    // Remove the old avatar file (if it lives in our avatar dir)
    const old = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.session.user.id)?.avatar_url;
    if (old && old.startsWith('/media/avatars/')) {
      const oldPath = path.join(AVATAR_DIR, path.basename(old));
      try { fs.unlinkSync(oldPath); } catch {}
    }

    db.prepare('UPDATE users SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(url, req.session.user.id);
    req.session.user.avatar_url = url;

    res.redirect('/account?success=' + encodeURIComponent('Avatar updated'));
  });
});

// ==================== REMOVE AVATAR ====================
router.post('/avatar/remove', requireAuth, (req, res) => {
  const old = db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(req.session.user.id)?.avatar_url;
  if (old && old.startsWith('/media/avatars/')) {
    const oldPath = path.join(AVATAR_DIR, path.basename(old));
    try { fs.unlinkSync(oldPath); } catch {}
  }
  db.prepare('UPDATE users SET avatar_url = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.session.user.id);
  req.session.user.avatar_url = null;
  res.redirect('/account?success=' + encodeURIComponent('Avatar removed'));
});

export default router;
