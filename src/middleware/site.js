/**
 * Site middleware — resolve which site this request is for.
 *
 * Resolution order (hub-modus):
 *   1. Pad /user/:slug → die site  (legacy /sites/:slug → 301 naar /user/)
 *   2. Anders (solo, of hub-landing): de primaire/hoofd-site
 *
 * Sets res.locals.site for all downstream handlers.
 */

import db from '../config/database.js';
import { getTenancy } from '../services/SettingsService.js';
import { audioUrl } from '../services/AudioStreamService.js';
import { audioEnabled } from '../config/features.js';

/**
 * The primary/main site — ONE source of truth (replaces the "oldest site ="
 * main" assumption that was previously scattered across resolveSite/hub/account/admin).
 * Reads the explicit is_primary flag; falls back to the oldest if it isn't set
 * anywhere yet, so existing behaviour is preserved exactly.
 */
export function getPrimarySite() {
  return db.prepare('SELECT * FROM sites WHERE is_primary = 1 LIMIT 1').get()
      || db.prepare('SELECT * FROM sites ORDER BY created_at ASC LIMIT 1').get()
      || null;
}

export function resolveSite(req, res, next) {
  const tenancy = getTenancy();
  res.locals.tenancy = tenancy; // also available in views

  // In HUB mode /user/:slug maps to a specific site. In SOLO mode there is only
  // one site: we skip that routing and pin to the primary site.
  if (tenancy === 'hub') {
    // A Klonkt site is canonically reachable via /user/:slug. /sites/:slug is a
    // legacy alias → 301 to the canonical form so one URL scheme remains
    // (preserves path + query string; does NOT touch /admin/sites, which starts with /admin/).
    const m = req.path.match(/^\/(sites|user)\/([a-zA-Z0-9_-]+)(\/.*)?$/);
    if (m) {
      if (m[1] === 'sites') {
        return res.redirect(301, req.originalUrl.replace(/^\/sites\//, '/user/'));
      }
      const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(m[2]);
      if (site) {
        res.locals.site = site;
        req.url = (m[3] || '/'); // strip /user/:slug zodat downstream de rest ziet
        res.locals.siteUrlBase = `/user/${m[2]}`;
        return next();
      }
    }
    // (Removed: a dead "slug == hostname" subdomain hack. Slugs may not contain
    // dots, so it could never match. Real subdomain routing would match the
    // subdomain LABEL against the slug — a separate feature, not this.)
  }

  // Solo (or hub without a match): pin to the primary/main site.
  const defaultSite = getPrimarySite();
  if (defaultSite) {
    res.locals.site = defaultSite;
    res.locals.siteUrlBase = '';
  }

  next();
}

/**
 * Audio tracks loader — pulls site-level tracks for the persistent player widget.
 * Per Robin: player is separate from the footer, gated by site.enable_audio_player.
 * Returns empty array if no site or audio is disabled — shell.ejs uses the
 * length to decide whether to mount audio-player.js.
 */
export function loadAudioTracks(req, res, next) {
  if (!audioEnabled()) { res.locals.audioTracks = []; return next(); }   // lite-modus
  const site = res.locals.site;
  if (!site || site.enable_audio_player === 0) {
    res.locals.audioTracks = [];
    return next();
  }

  try {
    // m.filename = the bare filename; the playable URL is the gated stream route
    // (audioUrl). The media table has NO url column — the old query selected
    // m.url and always failed silently (empty player). Now we build the URL from filename.
    const rows = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration, t.position, m.filename
      FROM audio_tracks t
      LEFT JOIN media m ON m.id = t.media_id
      WHERE t.site_id = ?
      ORDER BY t.position ASC, t.created_at ASC
    `).all(site.id);
    res.locals.audioTracks = rows.map((r) => ({
      id: r.id, title: r.title, artist: r.artist, duration: r.duration, position: r.position,
      media_url: r.filename ? audioUrl(r.filename) : null,
    }));
  } catch (e) {
    // media table might not be queryable in some test setups — fall back gracefully
    res.locals.audioTracks = [];
  }

  next();
}

/**
 * Theme loader — applies user/site theme preferences.
 */
export function loadTheme(req, res, next) {
  const PALETTES = ['klonkt','paper','forest','sunset','cream','lilac','ocean','candy'];
  
  const user = req.session?.user;
  const site = res.locals.site;
  
  // Priority: user setting > site setting > default
  const palette = (user && PALETTES.includes(user.palette) ? user.palette : null)
                || (site && PALETTES.includes(site.palette) ? site.palette : null)
                || 'klonkt';
  
  res.locals.palette = palette;
  res.locals.theme = (user && ['dark','light'].includes(user.theme)) ? user.theme : 'dark';
  
  next();
}
