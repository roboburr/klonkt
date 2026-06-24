import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { loginLimiter, registerLimiter } from '../middleware/rate-limit.js';
import { safeNext, requireAuth } from '../middleware/auth.js';
import { mailerConfigured, sendMail } from '../config/mailer.js';
import { resolveLang, t } from '../services/i18n.js';
import { setSetting } from '../services/SettingsService.js';

const router = express.Router();

// Fixed dummy hash: ensures login always runs one bcrypt comparison, even when the
// user doesn't exist or has no password — no timing oracle for enumeration.
const DUMMY_HASH = bcrypt.hashSync('constant-time-login-guard', 10);

// Canonical base URL for links in emails (reset). Building it from headers is
// spoofable (X-Forwarded-Host); a fixed config eliminates that risk.
function publicBaseUrl(req) {
  const cfg = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (cfg) return cfg;
  // Fallback (dev): trust-proxy-sanitised protocol + Host header (NOT the raw
  // X-Forwarded-Host).
  return `${req.protocol}://${req.get('host')}`;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// First-time setup? Only while there are no users yet may /register create an
// admin account. Afterwards registration is closed (listeners come via Google).
function isSetupMode() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
}

// ==================== LOGIN ====================
// Single login = admin/owner password (no public/listener login anymore; social
// interaction happens via the fediverse). /login and /auth/admin both show it.
router.get('/login', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  if (isSetupMode()) return res.redirect('/auth/register' + (next ? '?next=' + encodeURIComponent(next) : ''));
  renderPage(req, res, 'pages/auth-login', {
    pageTitle: 'Inloggen',
    bodyClass: 'on-special on-auth',
    error: req.query.error || null,
    gerr: null,
    success: req.query.success || null,
    username: '',
    adminLogin: true,
    googleReady: false,
    next,
  });
});

// Hidden admin login (username + password). Not linked anywhere in the UI —
// the admin navigates here directly (/auth/admin).
router.get('/admin', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  if (isSetupMode()) return res.redirect('/auth/register' + (next ? '?next=' + encodeURIComponent(next) : ''));
  renderPage(req, res, 'pages/auth-login', {
    pageTitle: 'Beheerder inloggen',
    bodyClass: 'on-special on-auth',
    error: req.query.error || null,
    gerr: null,
    success: req.query.success || null,
    username: '',
    adminLogin: true,
    googleReady: false,
    next,
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const next = safeNext(req.body.next) || '';

  // Error display on the (hidden) admin login page: re-show the password
  // form (adminLogin:true), not the Google-only public page.
  const renderErr = (error, status = 400) => {
    res.status(status);
    return renderPage(req, res, 'pages/auth-login', {
      pageTitle: 'Beheerder inloggen', bodyClass: 'on-special on-auth',
      error, gerr: null, success: null, username: username || '',
      adminLogin: true, googleReady: false, next,
    });
  };

  if (!username || !password) return renderErr('Gebruikersnaam en wachtwoord vereist');

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  // Always one bcrypt comparison (dummy if the user has no usable password)
  // so response time reveals nothing about whether the account exists.
  const usable = !!(user && user.password_hash && user.password_hash !== '!google-oauth');
  const ok = bcrypt.compareSync(password, usable ? user.password_hash : DUMMY_HASH);
  if (!usable || !ok) return renderErr('Ongeldige inloggegevens', 401);

  req.session.user = {
    id: user.id, username: user.username, email: user.email, role: user.role,
    avatar_url: user.avatar_url, palette: user.palette, theme: user.theme,
    readonly: !!user.readonly,
  };
  res.redirect(next || '/');
});

// ==================== FIRST-TIME SETUP (create admin account) ====================
router.get('/register', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  // No public registration: only the very first admin may be created here.
  if (!isSetupMode()) return res.redirect('/auth/login' + (next ? '?next=' + encodeURIComponent(next) : ''));
  renderPage(req, res, 'pages/auth-register', {
    pageTitle: t(resolveLang(req), 'setup.title'), bodyClass: 'on-special',
    error: null, username: '', email: '', siteName: '', next,
  });
});

router.post('/register', registerLimiter, (req, res) => {
  const { username, email, password, siteName } = req.body;
  const next = safeNext(req.body.next) || '';
  const renderErr = (error) => renderPage(req, res, 'pages/auth-register', {
    pageTitle: t(resolveLang(req), 'setup.title'), bodyClass: 'on-special',
    error, username: username || '', email: email || '', siteName: siteName || '', next,
  });

  // Hard-closed once a user exists — prevents a second "admin" via this route.
  if (!isSetupMode()) return res.redirect('/auth/login');

  if (!username || !email || !password) return renderErr('Alle velden zijn verplicht');
  if (!/^[a-z0-9_-]{3,32}$/i.test(username)) {
    return renderErr('Gebruikersnaam: 3-32 tekens, letters/cijfers/_/- alleen');
  }
  if (password.length < 8) return renderErr('Wachtwoord moet minstens 8 tekens zijn');

  const userId = uuid();
  const hash = bcrypt.hashSync(password, 10);
  // The very first user is the administrator (god).
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, theme, palette)
    VALUES (?, ?, ?, ?, 'god', 'dark', 'sage')
  `).run(userId, username, email, hash);

  // Auto-create a personal site (single-tenant restructure follows later).
  // Setup wizard: site name + language come from the form; language = the language
  // the visitor used to fill in the wizard (resolveLang) and becomes the site default.
  if (!db.prepare('SELECT 1 FROM sites LIMIT 1').get()) {
    const siteId = uuid();
    const lang = resolveLang(req);
    const title = (siteName || '').trim().slice(0, 80) || (username + "'s Site");
    db.prepare(`
      INSERT INTO sites (id, slug, title, description, owner_id, palette, accent, language)
      VALUES (?, ?, ?, ?, ?, 'klonkt', '#e8b04b', ?)
    `).run(siteId, username.toLowerCase(), title, '', userId, lang);
    db.prepare(`INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')`).run(siteId, userId);
    try { setSetting('default_lang', lang); } catch (e) { /* non-fatal */ }
  }

  req.session.user = { id: userId, username, email, role: 'god', palette: 'klonkt', theme: 'dark' };
  res.redirect(next || '/');
});

// ==================== FORGOT PASSWORD (request) ====================
router.get('/reset-request', (req, res) => {
  if (req.session.user) return res.redirect('/');
  renderPage(req, res, 'pages/auth-reset-request', {
    pageTitle: 'Wachtwoord resetten', bodyClass: 'on-special',
    error: null, sent: false, devResetUrl: null, mailer: mailerConfigured(),
  });
});

router.post('/reset-request', registerLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  let devResetUrl = null;

  if (email) {
    const user = db.prepare('SELECT id, email FROM users WHERE LOWER(email) = ?').get(email);
    if (user) {
      const token = crypto.randomBytes(32).toString('hex'); // raw: only goes into the mail/link
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
      // Store only the HASH: so DB read access yields no usable token.
      db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
        .run(hashToken(token), expires, user.id);

      const url = `${publicBaseUrl(req)}/auth/reset/${token}`;

      if (mailerConfigured()) {
        try {
          await sendMail({
            to: user.email,
            subject: 'Wachtwoord resetten',
            text: `Reset je wachtwoord via deze link (30 min geldig):\n\n${url}\n\nNiet aangevraagd? Negeer deze mail.`,
            html: `<p>Reset je wachtwoord via deze link (30 min geldig):</p><p><a href="${url}">${url}</a></p><p>Niet aangevraagd? Negeer deze mail.</p>`,
          });
        } catch (e) {
          console.error('[reset-request] mail faalde:', e.message);
        }
      } else if (process.env.NODE_ENV !== 'production') {
        // Dev without SMTP: show the link in the log + on the page.
        console.log(`[password-reset] ${user.email} -> ${url}`);
        devResetUrl = url;
      } else {
        // Production without SMTP: NEVER log the token. Refer to the CLI break-glass.
        console.log(`[password-reset] aangevraagd voor ${user.email} (geen SMTP — gebruik 'npm run reset-admin')`);
      }
    }
  }

  // Anti-enumeration: same response regardless of whether the address exists.
  renderPage(req, res, 'pages/auth-reset-request', {
    pageTitle: 'Wachtwoord resetten', bodyClass: 'on-special',
    error: null, sent: true, devResetUrl, mailer: mailerConfigured(),
  });
});

// ==================== RESET PASSWORD (apply) ====================
router.get('/reset/:token', (req, res) => {
  const row = db.prepare(`
    SELECT id, username FROM users
    WHERE reset_token = ? AND reset_token_expires > datetime('now')
  `).get(hashToken(req.params.token));
  renderPage(req, res, 'pages/auth-reset', {
    pageTitle: 'Wachtwoord resetten', bodyClass: 'on-special',
    error: row ? null : 'Deze reset-link is ongeldig of verlopen.',
    token: row ? req.params.token : null,
    username: row ? row.username : null,
  });
});

router.post('/reset/:token', (req, res) => {
  const { new_password, confirm } = req.body;
  const row = db.prepare(`
    SELECT id, username FROM users
    WHERE reset_token = ? AND reset_token_expires > datetime('now')
  `).get(hashToken(req.params.token));

  const renderError = (msg) => renderPage(req, res, 'pages/auth-reset', {
    pageTitle: 'Wachtwoord resetten', bodyClass: 'on-special',
    error: msg, token: row ? req.params.token : null, username: row ? row.username : null,
  });

  if (!row) return renderError('Deze reset-link is ongeldig of verlopen.');
  if (!new_password || new_password.length < 8) return renderError('Wachtwoord moet minstens 8 tekens zijn');
  if (new_password !== confirm) return renderError('Wachtwoorden komen niet overeen');

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare(`
    UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(hash, row.id);
  res.redirect('/auth/admin?success=' + encodeURIComponent('Wachtwoord gereset — log nu in.'));
});

// ==================== LOGOUT ====================
router.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
router.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

export default router;
