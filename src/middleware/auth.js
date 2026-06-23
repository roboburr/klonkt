/**
 * Auth middleware
 */

import db from '../config/database.js';
import PermissionsService from '../services/PermissionsService.js';

/**
 * Validate a "next" URL for safe redirect after login.
 * Returns the URL if safe, otherwise null.
 *
 * Rules:
 *  - Must be a string, max 256 chars (prevent abuse).
 *  - Must start with "/" but NOT "//" or "/\" (no protocol-relative open redirects).
 *  - Must not point back at /auth/* (prevents login → login loop).
 */
export function safeNext(raw) {
  if (typeof raw !== 'string' || !raw.length || raw.length > 256) return null;
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null;
  if (/^\/auth(\/|$)/i.test(raw)) return null;
  return raw;
}

function loginRedirect(req, res) {
  // Preserve the originally-requested URL so login can return us there.
  const next = encodeURIComponent(req.originalUrl || req.url || '/');
  const target = `/auth/login?next=${next}`;
  if (req.headers['hx-request'] === 'true') {
    res.setHeader('HX-Redirect', target);
    return res.status(401).send('Login required');
  }
  return res.redirect(target);
}

export function requireAuth(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  next();
}

// A 'kijker' (viewer) may VIEW everything (incl. Admin) but CHANGE nothing. The
// write block lives in the global guard in server.js; this helper only determines
// "is this a read-only account?". `readonly` is the legacy flag we still include
// so unmigrated demo accounts remain blocked.
export function isViewer(user) {
  return !!user && (user.role === 'kijker' || !!user.readonly);
}

export function requireGod(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const role = req.session.user.role;
  // god manages; a viewer MAY see the Admin panel (read-only) — the
  // global guard 403s every write, so this only grants view access.
  if (role !== 'god' && role !== 'kijker') {
    return res.status(403).send('God role required');
  }
  next();
}

// Can the logged-in user manage the CURRENT site (res.locals.site)? god always;
// otherwise only the owner of that site. Used for site-scoped admin routes
// that an artist reaches via /user/<own-slug>/admin/... (res.locals.site is then
// their own site; a foreign slug yields a different site -> 403).
export function requireSiteManager(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const u = req.session.user;
  if (u.role === 'god' || u.role === 'kijker') return next(); // viewer = read-only view access
  const site = res.locals.site;
  // owner OR assigned co-admin (site_members) — canAdminSite covers both.
  if (site && PermissionsService.canAdminSite(u, site)) return next();
  return res.status(403).send('Geen toegang tot deze site.');
}

// Same, but the site is determined by the :slug parameter (e.g. site-edit).
export function requireSiteManagerBySlug(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const u = req.session.user;
  if (u.role === 'god' || u.role === 'kijker') return next(); // viewer = read-only view access
  const site = db.prepare('SELECT id, owner_id FROM sites WHERE slug = ?').get(req.params.slug);
  if (site && PermissionsService.canAdminSite(u, site)) return next();
  return res.status(403).send('Geen toegang tot deze site.');
}
