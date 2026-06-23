/**
 * EPK / press kit (premium) — a shareable press page per Klonkt site.
 *
 * GET /pers  (solo) or /user/:slug/pers (hub, via resolveSite + siteUrlBase)
 *   -> clean, public press kit: hero (photo/title/tagline), short bio, top tracks,
 *      recent posts and a contact button. Intended to share with bookers/press.
 *
 * Premium-gated: non-premium instances have NO /pers (next() -> 404 via the
 * catch-all). The PAGE itself is public (no login) so press can view it;
 * only its EXISTENCE is premium. No login email leak: contact goes via an
 * explicitly configured press address (epk_contact, per site) or the site itself.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { getSetting } from '../services/SettingsService.js';

const router = express.Router();

router.get('/pers', (req, res, next) => {
  if (!premiumUnlocked()) return next();      // no premium -> no press kit
  const site = res.locals.site;
  if (!site) return next();

  // Tracks on the press kit: an admin-CHOSEN selection (max 5, in custom order)
  // if configured; otherwise automatically the top 5 most-listened.
  let chosenIds = [];
  try {
    const raw = JSON.parse(getSetting('epk_tracks_' + site.id, '') || '[]');
    if (Array.isArray(raw)) chosenIds = raw.filter((x) => typeof x === 'string').slice(0, 5);
  } catch (e) { /* invalid JSON → fall back to top */ }

  let tracks;
  if (chosenIds.length) {
    const ph = chosenIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, title, artist, duration, cover_url, COALESCE(play_count, 0) AS plays
         FROM audio_tracks WHERE site_id = ? AND id IN (${ph})`
    ).all(site.id, ...chosenIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    tracks = chosenIds.map((id) => byId.get(id)).filter(Boolean);  // preserve chosen order
  } else {
    tracks = db.prepare(
      `SELECT title, artist, duration, cover_url, COALESCE(play_count, 0) AS plays
         FROM audio_tracks
        WHERE site_id = ?
        ORDER BY plays DESC, position ASC, created_at ASC
        LIMIT 5`
    ).all(site.id);
  }

  const posts = db.prepare(
    `SELECT slug, title, created_at
       FROM posts
      WHERE site_id = ? AND status = 'published'
      ORDER BY created_at DESC
      LIMIT 5`
  ).all(site.id);

  // Press contact: per-site setting (epk_contact_<siteId>) if present, otherwise
  // the global epk_contact. NEVER auto-expose the login email.
  const contact = (getSetting('epk_contact_' + site.id, '') || getSetting('epk_contact', '') || '').trim();
  // Short press bio: per-site setting, otherwise the site's tagline.
  const bio = (getSetting('epk_bio_' + site.id, '') || site.tagline || '').trim();

  renderPage(req, res, 'pages/epk', {
    pageTitle: (site.title || 'Perskit') + ' — Perskit',
    bodyClass: 'on-epk',
    epkTracks: tracks,
    epkPosts: posts,
    epkContact: contact,
    epkBio: bio,
  });
});

export default router;
