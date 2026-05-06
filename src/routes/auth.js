import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { loginLimiter, registerLimiter } from '../middleware/rate-limit.js';
import { safeNext } from '../middleware/auth.js';

const router = express.Router();

// ==================== LOGIN ====================
router.get('/login', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  renderPage(req, res, 'pages/auth-login', {
    pageTitle: 'Login',
    bodyClass: 'on-special',
    error: null,
    success: req.query.success || null,
    username: '',
    next,
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const next = safeNext(req.body.next) || '';

  if (!username || !password) {
    res.status(400);
    return renderPage(req, res, 'pages/auth-login', {
      pageTitle: 'Login',
      bodyClass: 'on-special',
      error: 'Username and password required',
      username: username || '',
      next,
    });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE username = ? OR email = ?'
  ).get(username, username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    res.status(401);
    return renderPage(req, res, 'pages/auth-login', {
      pageTitle: 'Login',
      bodyClass: 'on-special',
      error: 'Invalid credentials',
      username: username,
      next,
    });
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
});

// ==================== REGISTER ====================
router.get('/register', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  renderPage(req, res, 'pages/auth-register', {
    pageTitle: 'Register',
    bodyClass: 'on-special',
    error: null,
    username: '',
    email: '',
    next,
  });
});

router.post('/register', registerLimiter, (req, res) => {
  const { username, email, password } = req.body;
  const next = safeNext(req.body.next) || '';

  // Validation
  if (!username || !email || !password) {
    return renderPage(req, res, 'pages/auth-register', {
      pageTitle: 'Register',
      bodyClass: 'on-special',
      error: 'All fields required',
      username: username || '',
      email: email || '',
      next,
    });
  }

  if (!/^[a-z0-9_-]{3,32}$/i.test(username)) {
    return renderPage(req, res, 'pages/auth-register', {
      pageTitle: 'Register',
      bodyClass: 'on-special',
      error: 'Username: 3-32 characters, letters/numbers/underscore/dash only',
      username, email, next,
    });
  }

  if (password.length < 8) {
    return renderPage(req, res, 'pages/auth-register', {
      pageTitle: 'Register',
      bodyClass: 'on-special',
      error: 'Password must be at least 8 characters',
      username, email, next,
    });
  }

  // Check uniqueness
  const existing = db.prepare(
    'SELECT id FROM users WHERE username = ? OR email = ?'
  ).get(username, email);

  if (existing) {
    return renderPage(req, res, 'pages/auth-register', {
      pageTitle: 'Register',
      bodyClass: 'on-special',
      error: 'Username or email already taken',
      username, email, next,
    });
  }

  // Create user
  const userId = uuid();
  const hash = bcrypt.hashSync(password, 10);

  // First user becomes god
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const role = userCount === 0 ? 'god' : 'member';

  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, theme, palette)
    VALUES (?, ?, ?, ?, ?, 'dark', 'sage')
  `).run(userId, username, email, hash, role);

  // First user gets a personal site auto-created
  if (userCount === 0) {
    const siteId = uuid();
    const siteSlug = username.toLowerCase();
    db.prepare(`
      INSERT INTO sites (id, slug, title, description, owner_id, palette, accent, language)
      VALUES (?, ?, ?, ?, ?, 'sage', '#c2410c', 'nl')
    `).run(siteId, siteSlug, username + "'s Site", 'Welcome to my site', userId);
    
    db.prepare(`
      INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')
    `).run(siteId, userId);
  }

  req.session.user = {
    id: userId, username, email, role,
    palette: 'sage', theme: 'dark',
  };

  res.redirect(next || '/');
});

// ==================== PASSWORD RESET (request) ====================
router.get('/reset-request', (req, res) => {
  if (req.session.user) return res.redirect('/');
  renderPage(req, res, 'pages/auth-reset-request', {
    pageTitle: 'Reset password',
    bodyClass: 'on-special',
    error: null,
    sent: false,
    devResetUrl: null,
  });
});

router.post('/reset-request', registerLimiter, (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  let devResetUrl = null;

  if (email) {
    const user = db.prepare('SELECT id, email FROM users WHERE LOWER(email) = ?').get(email);
    if (user) {
      // Generate token (32-byte hex, ~10 min expiry)
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
      db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?')
        .run(token, expires, user.id);

      // No email sender yet — log the reset URL so dev can use it.
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      const host = req.headers['x-forwarded-host'] || req.get('host');
      const url = `${proto}://${host}/auth/reset/${token}`;
      console.log(`[password-reset] ${email} -> ${url}`);
      if (process.env.NODE_ENV !== 'production') devResetUrl = url;
    }
  }

  // Anti-enumeration: same response regardless of whether the email exists.
  renderPage(req, res, 'pages/auth-reset-request', {
    pageTitle: 'Reset password',
    bodyClass: 'on-special',
    error: null,
    sent: true,
    devResetUrl,
  });
});

// ==================== PASSWORD RESET (apply) ====================
router.get('/reset/:token', (req, res) => {
  const row = db.prepare(`
    SELECT id, username FROM users
    WHERE reset_token = ? AND reset_token_expires > datetime('now')
  `).get(req.params.token);

  if (!row) {
    return renderPage(req, res, 'pages/auth-reset', {
      pageTitle: 'Reset password',
      bodyClass: 'on-special',
      error: 'This reset link is invalid or has expired.',
      token: null,
      username: null,
    });
  }

  renderPage(req, res, 'pages/auth-reset', {
    pageTitle: 'Reset password',
    bodyClass: 'on-special',
    error: null,
    token: req.params.token,
    username: row.username,
  });
});

router.post('/reset/:token', (req, res) => {
  const { new_password, confirm } = req.body;
  const row = db.prepare(`
    SELECT id, username FROM users
    WHERE reset_token = ? AND reset_token_expires > datetime('now')
  `).get(req.params.token);

  const renderError = (msg) => renderPage(req, res, 'pages/auth-reset', {
    pageTitle: 'Reset password',
    bodyClass: 'on-special',
    error: msg,
    token: row ? req.params.token : null,
    username: row ? row.username : null,
  });

  if (!row) return renderError('This reset link is invalid or has expired.');
  if (!new_password || new_password.length < 8) {
    return renderError('Password must be at least 8 characters');
  }
  if (new_password !== confirm) {
    return renderError('Passwords do not match');
  }

  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare(`
    UPDATE users
    SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(hash, row.id);

  // Force login (don't auto-log them in — let them prove ownership)
  res.redirect('/auth/login?success=' + encodeURIComponent('Password reset — please log in.'));
});

// ==================== LOGOUT ====================
router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

export default router;
