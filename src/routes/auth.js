import express from 'express';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { safeNext } from '../middleware/auth.js';
import { googleConfigured, authorizeUrl, exchangeCode, fetchUserinfo } from '../config/google.js';

const router = express.Router();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// ==================== LOGIN (alleen Google) ====================
// Het oude username/wachtwoord-systeem is verwijderd; inloggen gaat via Google.
router.get('/login', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  renderPage(req, res, 'pages/auth-login', {
    pageTitle: 'Inloggen',
    bodyClass: 'on-special',
    googleReady: googleConfigured(),
    error: req.query.error || null,
    next,
  });
});

// Start de Google OAuth-flow.
router.get('/google', (req, res) => {
  if (!googleConfigured()) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Google-login is op deze site nog niet geconfigureerd.'));
  }
  const next = safeNext(req.query.next) || '';
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.oauthNext = next;
  res.redirect(authorizeUrl(state));
});

// Leid een geldige, unieke username af uit naam/e-mail (schema vereist username).
function uniqueUsername(base) {
  let u = String(base || 'luisteraar').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 28);
  if (u.length < 3) u = 'luisteraar';
  let candidate = u, n = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(candidate)) {
    candidate = (u.slice(0, 26) + n).slice(0, 32);
    n++;
  }
  return candidate;
}

// Google callback: wissel code in, haal profiel, vind-of-maak user (op e-mail),
// zet de sessie. ADMIN_EMAIL bepaalt wie owner/admin (god) is.
router.get('/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/auth/login?error=' + encodeURIComponent(msg));
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) {
      return fail('Login afgebroken of ongeldige sessie.');
    }
    const next = safeNext(req.session.oauthNext) || '';
    delete req.session.oauthState;
    delete req.session.oauthNext;

    const tok = await exchangeCode(String(code));
    const info = await fetchUserinfo(tok.access_token);
    const email = (info.email || '').trim().toLowerCase();
    if (!email || info.email_verified === false) {
      return fail('Geen geverifieerd Google-e-mailadres ontvangen.');
    }

    const isAdmin = !!ADMIN_EMAIL && email === ADMIN_EMAIL;
    let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);

    if (!user) {
      const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      const role = (isAdmin || userCount === 0) ? 'god' : 'member';
      const userId = uuid();
      const username = uniqueUsername(info.name || email.split('@')[0]);
      // password_hash is NOT NULL in het schema; we zetten een onbruikbare
      // sentinel (er is geen wachtwoord-login meer).
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, role, avatar_url, theme, palette, google_sub)
        VALUES (?, ?, ?, '!google-oauth', ?, ?, 'dark', 'sage', ?)
      `).run(userId, username, info.email || email, role, info.picture || null, info.sub || null);

      // Eerste/admin-user krijgt een persoonlijke site (zoals de oude flow), maar
      // alleen als er nog geen site bestaat.
      if (role === 'god' && !db.prepare('SELECT 1 FROM sites LIMIT 1').get()) {
        const siteId = uuid();
        db.prepare(`
          INSERT INTO sites (id, slug, title, description, owner_id, palette, accent, language)
          VALUES (?, ?, ?, ?, ?, 'sage', '#c2410c', 'nl')
        `).run(siteId, username.toLowerCase(), username + "'s Site", 'Welkom', userId);
        db.prepare(`INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')`).run(siteId, userId);
      }
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    } else {
      // Bestaande user (gekoppeld op e-mail): koppel Google-id + avatar als die
      // nog ontbreken, en promoveer naar god als dit ADMIN_EMAIL is.
      db.prepare(`
        UPDATE users
        SET google_sub = COALESCE(google_sub, ?),
            avatar_url = COALESCE(avatar_url, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(info.sub || null, info.picture || null, user.id);
      if (isAdmin && user.role !== 'god') {
        db.prepare("UPDATE users SET role = 'god' WHERE id = ?").run(user.id);
        user.role = 'god';
      }
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar_url: user.avatar_url,
      palette: user.palette,
      theme: user.theme,
    };
    res.redirect(next || '/');
  } catch (e) {
    console.error('[auth/google/callback]', e.message);
    fail('Google-login mislukt. Probeer opnieuw.');
  }
});

// ==================== LOGOUT ====================
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

export default router;
