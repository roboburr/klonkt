/**
 * Admin: Edit press kit (EPK) — per-site bio + press contact.
 *
 * GET  /admin/epk   -> form with current bio + contact
 * POST /admin/epk   -> save (app_settings: epk_bio_<siteId> / epk_contact_<siteId>)
 *
 * The press kit page itself (/pers) reads these values; tracks + recent posts come
 * automatically. Press kit is premium + solo (see routes/epk.js).
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { getSetting, setSetting } from '../services/SettingsService.js';
import { premiumUnlocked } from '../services/PatreonService.js';

const router = express.Router();

const MAX_EPK_TRACKS = 5;

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Geen site');
  if (!premiumUnlocked()) {
    return res.status(403).send('Perskit is een premium-functie.');
  }
  const allTracks = db.prepare(
    `SELECT id, title, artist FROM audio_tracks WHERE site_id = ? ORDER BY position ASC, created_at ASC`
  ).all(site.id);
  let chosen = [];
  try { const r = JSON.parse(getSetting('epk_tracks_' + site.id, '') || '[]'); if (Array.isArray(r)) chosen = r; } catch (e) {}
  renderPage(req, res, 'pages/admin-epk', {
    pageTitleKey: 'admin.t_epk',
    bodyClass: 'on-admin',
    site,
    epkBio: getSetting('epk_bio_' + site.id, '') || '',
    epkContact: getSetting('epk_contact_' + site.id, '') || '',
    allTracks,
    chosenTracks: chosen,
    maxEpkTracks: MAX_EPK_TRACKS,
    success: req.query.success || null,
  });
});

router.post('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Geen site');
  setSetting('epk_bio_' + site.id, (req.body.epk_bio || '').toString().slice(0, 1000).trim());
  setSetting('epk_contact_' + site.id, (req.body.epk_contact || '').toString().slice(0, 300).trim());
  // Chosen tracks: only ids belonging to THIS site, max 5, in the supplied order.
  let ids = req.body.epk_tracks;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  const valid = new Set(db.prepare('SELECT id FROM audio_tracks WHERE site_id = ?').all(site.id).map((r) => r.id));
  ids = ids.map(String).filter((id) => valid.has(id)).slice(0, MAX_EPK_TRACKS);
  setSetting('epk_tracks_' + site.id, JSON.stringify(ids));
  res.redirect('/admin/epk?success=' + encodeURIComponent('Perskit opgeslagen'));
});

export default router;
