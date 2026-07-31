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
  // One instance is one owner (Robins besluit, 31-7): there is one site tree,
  // pinned to the primary site. The /user/:slug routing that hub mode needed
  // is gone with it.
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
  const PALETTES = ['klonkt','forest','ocean','teal','lilac','sunset','candy','amber'];
  
  const user = req.session?.user;
  const site = res.locals.site;
  
  // A site always renders in ITS OWN palette, regardless of who is viewing. There is
  // no per-user palette UI (user.palette is vestigial/stale data from old migrations),
  // and the htmx pcmsNav path (render.js) already uses the site palette only — so reading
  // user.palette here made a full page load (owner logged in) flip to the viewer's stale
  // palette while htmx-nav kept the site's, i.e. "palette changes on hard refresh".
  const palette = (site && PALETTES.includes(site.palette) ? site.palette : null)
                || 'klonkt';

  res.locals.palette = palette;
  res.locals.theme = (user && ['dark','light'].includes(user.theme)) ? user.theme : 'dark';
  
  next();
}
