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

// Een 'kijker' mag ALLES bekijken (incl. Beheer) maar NIETS wijzigen. De
// schrijf-blokkade zit in de globale guard in server.js; deze helper bepaalt
// alleen "is dit een alleen-lezen account?". `readonly` is de legacy-vlag die
// we nog meenemen zodat niet-gemigreerde demo-accounts geblokkeerd blijven.
export function isViewer(user) {
  return !!user && (user.role === 'kijker' || !!user.readonly);
}

export function requireGod(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const role = req.session.user.role;
  // god beheert; een kijker mág het Beheer-paneel zien (alleen-lezen) — de
  // globale guard 403't elke write, dus dit geeft enkel kijk-toegang.
  if (role !== 'god' && role !== 'kijker') {
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
  if (u.role === 'god' || u.role === 'kijker') return next(); // kijker = alleen-lezen kijk-toegang
  const site = res.locals.site;
  // owner OF toegewezen mede-beheerder (site_members) — canAdminSite dekt beide.
  if (site && PermissionsService.canAdminSite(u, site)) return next();
  return res.status(403).send('Geen toegang tot deze site.');
}

// Idem, maar de site wordt bepaald door de :slug-parameter (bv. site-edit).
export function requireSiteManagerBySlug(req, res, next) {
  if (!req.session?.user) return loginRedirect(req, res);
  const u = req.session.user;
  if (u.role === 'god' || u.role === 'kijker') return next(); // kijker = alleen-lezen kijk-toegang
  const site = db.prepare('SELECT id, owner_id FROM sites WHERE slug = ?').get(req.params.slug);
  if (site && PermissionsService.canAdminSite(u, site)) return next();
  return res.status(403).send('Geen toegang tot deze site.');
}
