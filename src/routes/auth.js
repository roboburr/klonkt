import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { loginLimiter, registerLimiter } from '../middleware/rate-limit.js';
import { safeNext } from '../middleware/auth.js';
import { googleConfigured, authorizeUrl, exchangeCode, fetchUserinfo } from '../config/google.js';
import { premiumUnlocked } from '../services/PatreonService.js';

// Fan-login (luisteraars inloggen met Google om te reageren) is een premium-
// feature: beschikbaar als Google is ingesteld ÉN de premium-laag ontgrendeld is
// (premium uit = vrij; aan = Patreon vereist).
function fanLoginReady() {
  return googleConfigured() && premiumUnlocked();
}
import { mailerConfigured, sendMail } from '../config/mailer.js';

const router = express.Router();

// Vaste dummy-hash: zo draait login altijd één bcrypt-vergelijking, ook als de
// user niet bestaat of geen wachtwoord heeft — geen timing-oracle voor enumeratie.
const DUMMY_HASH = bcrypt.hashSync('constant-time-login-guard', 10);

// Canonieke basis-URL voor links in e-mails (reset). Uit headers bouwen is
// spoofbaar (X-Forwarded-Host); een vaste config sluit dat uit.
function publicBaseUrl(req) {
  const cfg = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (cfg) return cfg;
  // Fallback (dev): trust-proxy-gesaneerde protocol + Host-header (NIET de rauwe
  // X-Forwarded-Host).
  return `${req.protocol}://${req.get('host')}`;
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Eerste-keer-setup? Pas zolang er nog geen enkele gebruiker is mag /register een
// beheerder aanmaken. Daarna is registratie dicht (luisteraars komen via Google).
function isSetupMode() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0;
}

// ==================== LOGIN (beheerder = wachtwoord) ====================
router.get('/login', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  if (isSetupMode()) return res.redirect('/auth/register' + (next ? '?next=' + encodeURIComponent(next) : ''));
  renderPage(req, res, 'pages/auth-login', {
    pageTitle: 'Inloggen',
    bodyClass: 'on-special on-auth',
    error: null,
    success: req.query.success || null,
    username: '',
    googleReady: fanLoginReady(),
    next,
  });
});

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const next = safeNext(req.body.next) || '';

  const renderErr = (error, status = 400) => {
    res.status(status);
    return renderPage(req, res, 'pages/auth-login', {
      pageTitle: 'Inloggen', bodyClass: 'on-special',
      error, success: null, username: username || '', googleReady: fanLoginReady(), next,
    });
  };

  if (!username || !password) return renderErr('Gebruikersnaam en wachtwoord vereist');

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  // Altijd één bcrypt-vergelijking (dummy als de user geen bruikbaar wachtwoord
  // heeft) zodat de responstijd niets over het bestaan van een account verraadt.
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

// ==================== EERSTE-KEER-SETUP (beheerder aanmaken) ====================
router.get('/register', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  // Geen publieke registratie: alleen de allereerste beheerder mag hier aangemaakt.
  if (!isSetupMode()) return res.redirect('/auth/login' + (next ? '?next=' + encodeURIComponent(next) : ''));
  renderPage(req, res, 'pages/auth-register', {
    pageTitle: 'Beheerder aanmaken', bodyClass: 'on-special',
    error: null, username: '', email: '', next,
  });
});

router.post('/register', registerLimiter, (req, res) => {
  const { username, email, password } = req.body;
  const next = safeNext(req.body.next) || '';
  const renderErr = (error) => renderPage(req, res, 'pages/auth-register', {
    pageTitle: 'Beheerder aanmaken', bodyClass: 'on-special',
    error, username: username || '', email: email || '', next,
  });

  // Hard gesloten zodra er een gebruiker is — voorkomt een tweede "admin" via deze route.
  if (!isSetupMode()) return res.redirect('/auth/login');

  if (!username || !email || !password) return renderErr('Alle velden zijn verplicht');
  if (!/^[a-z0-9_-]{3,32}$/i.test(username)) {
    return renderErr('Gebruikersnaam: 3-32 tekens, letters/cijfers/_/- alleen');
  }
  if (password.length < 8) return renderErr('Wachtwoord moet minstens 8 tekens zijn');

  const userId = uuid();
  const hash = bcrypt.hashSync(password, 10);
  // De allereerste gebruiker is de beheerder (god).
  db.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, theme, palette)
    VALUES (?, ?, ?, ?, 'god', 'dark', 'sage')
  `).run(userId, username, email, hash);

  // Persoonlijke site auto-aanmaken (single-tenant-ombouw volgt later).
  if (!db.prepare('SELECT 1 FROM sites LIMIT 1').get()) {
    const siteId = uuid();
    db.prepare(`
      INSERT INTO sites (id, slug, title, description, owner_id, palette, accent, language)
      VALUES (?, ?, ?, ?, ?, 'sage', '#c2410c', 'nl')
    `).run(siteId, username.toLowerCase(), username + "'s Site", 'Welkom', userId);
    db.prepare(`INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')`).run(siteId, userId);
  }

  req.session.user = { id: userId, username, email, role: 'god', palette: 'sage', theme: 'dark' };
  res.redirect(next || '/');
});

// ==================== WACHTWOORD VERGETEN (aanvraag) ====================
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
      const token = crypto.randomBytes(32).toString('hex'); // ruw: gaat alleen de mail/link in
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
      // Alleen de HASH opslaan: DB-leestoegang levert zo geen bruikbaar token op.
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
        // Dev zonder SMTP: link in log + op de pagina tonen.
        console.log(`[password-reset] ${user.email} -> ${url}`);
        devResetUrl = url;
      } else {
        // Productie zonder SMTP: NOOIT het token loggen. Verwijs naar de CLI break-glass.
        console.log(`[password-reset] aangevraagd voor ${user.email} (geen SMTP — gebruik 'npm run reset-admin')`);
      }
    }
  }

  // Anti-enumeratie: zelfde antwoord ongeacht of het adres bestaat.
  renderPage(req, res, 'pages/auth-reset-request', {
    pageTitle: 'Wachtwoord resetten', bodyClass: 'on-special',
    error: null, sent: true, devResetUrl, mailer: mailerConfigured(),
  });
});

// ==================== WACHTWOORD RESETTEN (toepassen) ====================
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
  res.redirect('/auth/login?success=' + encodeURIComponent('Wachtwoord gereset — log nu in.'));
});

// ==================== GOOGLE-LOGIN (luisteraars/reageerders) ====================
// Per-instance, eigen Google-client. Geeft ALTIJD rol member — nooit beheer.
router.get('/google', (req, res) => {
  if (!fanLoginReady()) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Inloggen met Google is op deze site niet beschikbaar.'));
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.oauthNext = safeNext(req.query.next) || '';
  res.redirect(authorizeUrl(state));
});

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

router.get('/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/auth/login?error=' + encodeURIComponent(msg));
  if (!fanLoginReady()) return fail('Inloggen met Google is op deze site niet beschikbaar.');
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.oauthState) return fail('Login afgebroken of ongeldige sessie.');
    const next = safeNext(req.session.oauthNext) || '';
    delete req.session.oauthState;
    delete req.session.oauthNext;

    const tok = await exchangeCode(String(code));
    const info = await fetchUserinfo(tok.access_token);
    const email = (info.email || '').trim().toLowerCase();
    if (!email || info.email_verified === false) return fail('Geen geverifieerd Google-e-mailadres.');

    let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);

    if (user) {
      // Strikte scheiding: Google geeft nooit beheer. Hoort dit adres bij een
      // beheerder, dan moet diegene met wachtwoord inloggen (geen Google-bypass).
      if (user.role === 'god' || user.role === 'admin') {
        return fail('Dit adres hoort bij een beheerder — log in met je wachtwoord.');
      }
      // Bestaande luisteraar: koppel google_sub/avatar als die ontbreken; weiger
      // als al aan een ander Google-account gekoppeld.
      if (user.google_sub && info.sub && user.google_sub !== info.sub) {
        return fail('Dit e-mailadres is al aan een ander Google-account gekoppeld.');
      }
      db.prepare(`
        UPDATE users SET google_sub = COALESCE(google_sub, ?), avatar_url = COALESCE(avatar_url, ?),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(info.sub || null, info.picture || null, user.id);
    } else {
      // Nieuwe luisteraar — altijd member.
      const userId = uuid();
      const username = uniqueUsername(info.name || email.split('@')[0]);
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, role, avatar_url, theme, palette, google_sub)
        VALUES (?, ?, ?, '!google-oauth', 'member', ?, 'dark', 'sage', ?)
      `).run(userId, username, info.email || email, info.picture || null, info.sub || null);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    }

    req.session.user = {
      id: user.id, username: user.username, email: user.email, role: user.role,
      avatar_url: user.avatar_url, palette: user.palette, theme: user.theme,
      readonly: !!user.readonly,
    };
    res.redirect(next || '/');
  } catch (e) {
    console.error('[auth/google/callback]', e.message);
    fail('Google-login mislukt. Probeer opnieuw.');
  }
});

// ==================== LOGOUT ====================
router.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
router.post('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

export default router;
