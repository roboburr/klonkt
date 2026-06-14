/**
 * Auth middleware
 */

import db from '../config/database.js';

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

export function requireGod(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  if (req.session.user.role !== 'god') {
    return res.status(403).send('God role required');
  }
  next();
}

// Mag de ingelogde user de HUIDIGE site (res.locals.site) beheren? god altijd;
// anders alleen de owner van die site. Gebruikt voor site-gescopete beheerroutes
// die een artiest via /user/<eigen-slug>/admin/... bereikt (res.locals.site is dan
// z'n eigen site; een vreemde slug levert een andere site -> 403).
export function requireSiteManager(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const u = req.session.user;
  if (u.role === 'god') return next();
  const site = res.locals.site;
  if (site && site.owner_id === u.id) return next();
  return res.status(403).send('Geen toegang tot deze site.');
}

// Idem, maar de site wordt bepaald door de :slug-parameter (bv. site-edit).
export function requireSiteManagerBySlug(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const u = req.session.user;
  if (u.role === 'god') return next();
  const site = db.prepare('SELECT owner_id FROM sites WHERE slug = ?').get(req.params.slug);
  if (site && site.owner_id === u.id) return next();
  return res.status(403).send('Geen toegang tot deze site.');
}
