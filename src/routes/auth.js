import express from 'express';
import crypto from 'crypto';
import { v4 as uuid } from 'uuid';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { safeNext } from '../middleware/auth.js';
import { brokerConfigured, brokerStartUrl, verifyIdentityToken, consumeJti } from '../config/google.js';

const router = express.Router();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// ==================== LOGIN (Google via Klonkt-broker) ====================
// Het oude username/wachtwoord-systeem is verwijderd; inloggen gaat via Google,
// gerouteerd door de centrale broker (geen Google-creds op deze instance).
router.get('/login', (req, res) => {
  const next = safeNext(req.query.next) || '';
  if (req.session.user) return res.redirect(next || '/');
  renderPage(req, res, 'pages/auth-login', {
    pageTitle: 'Inloggen',
    bodyClass: 'on-special',
    googleReady: brokerConfigured(),
    error: req.query.error || null,
    next,
  });
});

// Start de login: random state in de sessie (CSRF), dan door naar de broker.
router.get('/google', (req, res) => {
  if (!brokerConfigured()) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Google-login is op deze site nog niet geconfigureerd.'));
  }
  const istate = crypto.randomBytes(16).toString('hex');
  req.session.loginState = istate;
  req.session.loginNext = safeNext(req.query.next) || '';
  res.redirect(brokerStartUrl(istate));
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

// Callback van de broker: ?klonkt_id_token=&klonkt_state=(&klonkt_login_error=).
// We checken state (CSRF), verifiëren het token (sig + audience + replay), en
// vinden-of-maken de user op e-mail. ADMIN_EMAIL bepaalt wie owner/admin (god) is.
router.get('/google/callback', async (req, res) => {
  const fail = (msg) => res.redirect('/auth/login?error=' + encodeURIComponent(msg));
  try {
    const { klonkt_id_token: idToken, klonkt_state: state, klonkt_login_error: loginError } = req.query;

    // State-check (CSRF) eerst — bind de callback aan de sessie die login startte.
    const expected = req.session.loginState;
    const next = safeNext(req.session.loginNext) || '';
    delete req.session.loginState;
    delete req.session.loginNext;
    if (!expected || state !== expected) return fail('Login afgebroken of ongeldige sessie.');

    if (loginError === 'unverified_email') return fail('Geen geverifieerd Google-e-mailadres.');
    if (!idToken) return fail('Geen logintoken ontvangen.');

    let payload;
    try {
      payload = await verifyIdentityToken(String(idToken));
    } catch (e) {
      console.error('[auth/google/callback] tokenverificatie:', e.message);
      return fail('Logintoken ongeldig of verlopen.');
    }
    if (!consumeJti(payload.jti, payload.exp)) return fail('Logintoken al gebruikt.');

    const email = (payload.email || '').trim().toLowerCase();
    if (!email) return fail('Geen e-mailadres in logintoken.');

    const isAdmin = !!ADMIN_EMAIL && email === ADMIN_EMAIL;
    let user = db.prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(email);

    if (!user) {
      const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
      // god = de ingestelde ADMIN_EMAIL. De "eerste user wordt god"-bootstrap geldt
      // ALLEEN als er helemaal geen ADMIN_EMAIL is ingesteld — anders zou een vreemde
      // die toevallig als eerste inlogt op een verse install eigenaar worden.
      const role = isAdmin ? 'god' : (!ADMIN_EMAIL && userCount === 0 ? 'god' : 'member');
      const userId = uuid();
      const username = uniqueUsername(payload.name || email.split('@')[0]);
      // password_hash is NOT NULL in het schema; er is geen wachtwoord-login meer,
      // dus we zetten een onbruikbare sentinel.
      db.prepare(`
        INSERT INTO users (id, username, email, password_hash, role, avatar_url, theme, palette, google_sub)
        VALUES (?, ?, ?, '!google-oauth', ?, ?, 'dark', 'sage', ?)
      `).run(userId, username, payload.email || email, role, payload.picture || null, payload.sub || null);

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
      // Identiteits-integriteit: als deze user al aan een ander Google-account
      // gekoppeld is (google_sub mismatch), weiger — voorkomt overname als een
      // geverifieerd e-mailadres ooit naar een andere Google-sub verhuist.
      if (user.google_sub && payload.sub && user.google_sub !== payload.sub) {
        return fail('Dit e-mailadres is al aan een ander Google-account gekoppeld.');
      }
      // Bestaande user (gekoppeld op e-mail): koppel Google-id + avatar als die
      // nog ontbreken, en promoveer naar god als dit ADMIN_EMAIL is.
      db.prepare(`
        UPDATE users
        SET google_sub = COALESCE(google_sub, ?),
            avatar_url = COALESCE(avatar_url, ?),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(payload.sub || null, payload.picture || null, user.id);
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
