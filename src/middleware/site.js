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

  // In HUB-mode mapt /user/:slug naar een specifieke site. In SOLO-mode bestaat
  // er maar één site: we slaan die routing over en pinnen op de primaire site.
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
    // (Verwijderd: een dode "slug == hostname"-subdomein-hack. Slugs mogen geen
    // punten bevatten, dus die kon nooit matchen. Echte subdomein-routing zou de
    // subdomein-LABEL tegen de slug matchen — een aparte feature, niet dit.)
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
    // m.filename = de kale bestandsnaam; de speelbare URL is de gated stream-route
    // (audioUrl). De media-tabel heeft GEEN url-kolom — de oude query selecteerde
    // m.url en faalde dus altijd stil (lege speler). Nu bouwen we de URL uit filename.
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
  const PALETTES = ['klonkt','sage','paper','ocean','forest','stone','midnight','sunset','cream','rose','slate','mint','lilac'];
  
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
