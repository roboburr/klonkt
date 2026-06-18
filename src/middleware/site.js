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
import { getTenancy } from '../services/SettingsService.js';

/**
 * De primaire/hoofd-site — ÉÉN bron van waarheid (vervangt de "oudste site ="
 * hoofd"-aanname die voorheen los in resolveSite/hub/account/admin stond).
 * Leest de expliciete is_primary-vlag; valt terug op de oudste als die (nog)
 * nergens staat, zodat bestaand gedrag exact behouden blijft.
 */
export function getPrimarySite() {
  return db.prepare('SELECT * FROM sites WHERE is_primary = 1 LIMIT 1').get()
      || db.prepare('SELECT * FROM sites ORDER BY created_at ASC LIMIT 1').get()
      || null;
}

export function resolveSite(req, res, next) {
  const tenancy = getTenancy();
  res.locals.tenancy = tenancy; // ook beschikbaar voor views

  // In HUB-mode mapt /sites/:slug en (later) een subdomein naar een specifieke
  // site. In SOLO-mode bestaat er maar één site: we slaan die routing over en
  // pinnen altijd op de primaire site.
  if (tenancy === 'hub') {
    // Een Klonkt-site is canoniek bereikbaar via /user/:slug. /sites/:slug is een
    // legacy-alias → 301 naar de canonieke vorm zodat er één URL-schema overblijft
    // (behoudt pad + querystring; raakt /admin/sites NIET, dat begint met /admin/).
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
    const host = req.get('host')?.toLowerCase().replace(/:\d+$/, '');
    if (host) {
      const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(host);
      if (site) {
        res.locals.site = site;
        res.locals.siteUrlBase = '';
        return next();
      }
    }
  }

  // Solo (of hub zonder match): pin op de primaire/hoofd-site.
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
