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
import { getPrimarySite } from '../middleware/site.js';
import { renderPage } from '../middleware/render.js';
import { requireAuth } from '../middleware/auth.js';
import { googleConfigured } from '../config/google.js';
import { toWebp } from '../services/ImageWebpService.js';
import { SUPPORTED } from '../services/i18n.js';

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
    SELECT id, username, email, role, bio, avatar_url, created_at, password_hash, google_sub, lang
    FROM users WHERE id = ?
  `).get(req.session.user.id);
  const hasPassword = !!(account && account.password_hash && account.password_hash !== '!google-oauth');
  const googleLinked = !!(account && account.google_sub);
  if (account) { delete account.password_hash; delete account.google_sub; } // don't leak to the view

  renderPage(req, res, 'pages/account', {
    pageTitle: 'Account',
    bodyClass: 'on-special',
    account,
    hasPassword,
    googleLinked,
    googleAvailable: googleConfigured(),
    editableSite: ownedSite(req.session.user),
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// ==================== PERSONAL INTERFACE LANGUAGE ====================
// Saves the language choice on the account (persists across devices/sessions) and
// also sets it in the session immediately so it takes effect right away.
router.post('/lang', requireAuth, (req, res) => {
  const code = SUPPORTED.includes(req.body.lang) ? req.body.lang : null;
  if (code) {
    db.prepare('UPDATE users SET lang = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(code, req.session.user.id);
    req.session.user.lang = code;
    req.session.lang = code;
  }
  res.redirect('/account?success=' + encodeURIComponent('Taal opgeslagen'));
});

// The site this user may edit from their account: their own site
// (owner_id), or for a god the primary site. Null if nothing found.
function ownedSite(user) {
  if (!user) return null;
  let site = db.prepare('SELECT id, title, tagline, slug, owner_id FROM sites WHERE owner_id = ? ORDER BY created_at LIMIT 1').get(user.id);
  if (!site && user.role === 'god') {
    site = getPrimarySite(); // primary/main site as fallback
  }
  return site || null;
}

// ==================== UPDATE SITE-NAAM (eigenaar) ====================
router.post('/site', requireAuth, (req, res) => {
  const site = ownedSite(req.session.user);
  if (!site) return res.redirect('/account?error=' + encodeURIComponent('Geen site om te bewerken.'));
  if (site.owner_id !== req.session.user.id && req.session.user.role !== 'god') {
    return res.redirect('/account?error=' + encodeURIComponent('Geen rechten om deze site te bewerken.'));
  }
  const title = (req.body.site_title || '').toString().slice(0, 200).trim();
  if (!title) return res.redirect('/account?error=' + encodeURIComponent('Site-naam mag niet leeg zijn.'));
  const tagline = (req.body.site_tagline || '').toString().slice(0, 200).trim();
  db.prepare('UPDATE sites SET title = ?, tagline = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(title, tagline || null, site.id);
  res.redirect('/account?success=' + encodeURIComponent('Site-naam bijgewerkt'));
});

// ==================== UPDATE BIO ====================
router.post('/profile', requireAuth, (req, res) => {
  const bio = (req.body.bio || '').toString().slice(0, 500).trim();

  // Email (optionally also changed). Validation: valid format + not already in use
  // by another account. Email is the login/reset anchor, so it must be unique.
  const email = (req.body.email || '').toString().trim();
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.redirect('/account?error=' + encodeURIComponent('Voer een geldig e-mailadres in.'));
    }
    const taken = db.prepare('SELECT 1 FROM users WHERE LOWER(email) = LOWER(?) AND id != ?')
      .get(email, req.session.user.id);
    if (taken) {
      return res.redirect('/account?error=' + encodeURIComponent('Dit e-mailadres is al in gebruik.'));
    }
    db.prepare('UPDATE users SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(email, req.session.user.id);
    req.session.user.email = email; // update session so the UI reflects the change
  }

  db.prepare('UPDATE users SET bio = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(bio || null, req.session.user.id);
  res.redirect('/account?success=' + encodeURIComponent('Profiel bijgewerkt'));
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
  // Google-only accounts (listeners) have no real password.
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

// Unlink Google account. Only allowed if a password is set,
// otherwise the user would lock themselves out (no login method left).
router.post('/google/unlink', requireAuth, (req, res) => {
  const row = db.prepare('SELECT password_hash, google_sub FROM users WHERE id = ?').get(req.session.user.id);
  if (!row || !row.google_sub) {
    return res.redirect('/account?error=' + encodeURIComponent('Er is geen Google-account gekoppeld'));
  }
  if (!row.password_hash || row.password_hash === '!google-oauth') {
    return res.redirect('/account?error=' + encodeURIComponent('Stel eerst een wachtwoord in — anders kun je niet meer inloggen.'));
  }
  db.prepare('UPDATE users SET google_sub = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.user.id);
  res.redirect('/account?success=' + encodeURIComponent('Google-account ontkoppeld'));
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

    const url = `/media/avatars/${toWebp(req.file)}`;

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
