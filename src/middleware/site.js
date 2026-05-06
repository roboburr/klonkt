/**
 * Site middleware — resolve which site this request is for.
 * 
 * Resolution order:
 *   1. Path /sites/:slug → that site
 *   2. (Future) Subdomain bedrijf1.example.com → matching site
 *   3. Default site (first one in DB)
 * 
 * Sets res.locals.site for all downstream handlers.
 */

import db from '../config/database.js';

export function resolveSite(req, res, next) {
  // Try /sites/:slug pattern
  const m = req.path.match(/^\/sites\/([a-zA-Z0-9_-]+)(\/.*)?$/);
  if (m) {
    const slug = m[1];
    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
    if (site) {
      res.locals.site = site;
      // Strip /sites/:slug from req.url so downstream routes see the rest
      req.url = (m[2] || '/');
      // Also rewrite originalUrl for redirect targets to keep the prefix
      res.locals.siteUrlBase = `/sites/${slug}`;
      return next();
    }
  }

  // Future: subdomain mapping
  const host = req.get('host')?.toLowerCase().replace(/:\d+$/, '');
  if (host) {
    const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(host);
    if (site) {
      res.locals.site = site;
      res.locals.siteUrlBase = '';
      return next();
    }
  }

  // Default: pick first site
  const defaultSite = db.prepare('SELECT * FROM sites ORDER BY created_at ASC LIMIT 1').get();
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
  const site = res.locals.site;
  if (!site || site.enable_audio_player === 0) {
    res.locals.audioTracks = [];
    return next();
  }

  try {
    res.locals.audioTracks = db.prepare(`
      SELECT t.id, t.title, t.artist, t.duration, t.position,
             m.url AS media_url
      FROM audio_tracks t
      LEFT JOIN media m ON m.id = t.media_id
      WHERE t.site_id = ?
      ORDER BY t.position ASC, t.created_at ASC
    `).all(site.id);
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
  const PALETTES = ['sage','paper','ocean','forest','stone','midnight','sunset','cream'];
  
  const user = req.session?.user;
  const site = res.locals.site;
  
  // Priority: user setting > site setting > default
  const palette = (user && PALETTES.includes(user.palette) ? user.palette : null)
                || (site && PALETTES.includes(site.palette) ? site.palette : null)
                || 'sage';
  
  res.locals.palette = palette;
  res.locals.theme = (user && ['dark','light'].includes(user.theme)) ? user.theme : 'dark';
  
  next();
}
