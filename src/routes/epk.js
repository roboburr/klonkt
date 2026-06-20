/**
 * EPK / perskit (premium) — een deelbare perspagina per Klonkt-site.
 *
 * GET /pers  (solo) of /user/:slug/pers (hub, via resolveSite + siteUrlBase)
 *   -> nette, openbare perskit: hero (foto/titel/tagline), korte bio, topnummers,
 *      recente posts en een contact-knop. Bedoeld om naar boekers/pers te sturen.
 *
 * Premium-gated: niet-premium instances hebben GEEN /pers (next() -> 404 via de
 * catch-all). De PAGINA zelf is openbaar (geen login) zodat pers 'm kan bekijken;
 * alleen het BESTAAN ervan is premium. Geen login-e-mail lekken: contact loopt via
 * een expliciet ingesteld pers-adres (epk_contact, per site) of anders de site zelf.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { getSetting } from '../services/SettingsService.js';

const router = express.Router();

router.get('/pers', (req, res, next) => {
  if (!premiumUnlocked()) return next();      // geen premium -> geen perskit
  const site = res.locals.site;
  if (!site) return next();

  // Nummers op de perskit: een door de admin GEKOZEN selectie (max 5, in eigen
  // volgorde) als die is ingesteld; anders automatisch de top 5 meest beluisterde.
  let chosenIds = [];
  try {
    const raw = JSON.parse(getSetting('epk_tracks_' + site.id, '') || '[]');
    if (Array.isArray(raw)) chosenIds = raw.filter((x) => typeof x === 'string').slice(0, 5);
  } catch (e) { /* ongeldige JSON → val terug op top */ }

  let tracks;
  if (chosenIds.length) {
    const ph = chosenIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, title, artist, duration, cover_url, COALESCE(play_count, 0) AS plays
         FROM audio_tracks WHERE site_id = ? AND id IN (${ph})`
    ).all(site.id, ...chosenIds);
    const byId = new Map(rows.map((r) => [r.id, r]));
    tracks = chosenIds.map((id) => byId.get(id)).filter(Boolean);  // behoud gekozen volgorde
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

  // Pers-contact: per-site instelling (epk_contact_<siteId>) als die er is, anders
  // de globale epk_contact. NOOIT automatisch de login-mail tonen.
  const contact = (getSetting('epk_contact_' + site.id, '') || getSetting('epk_contact', '') || '').trim();
  // Korte pers-bio: per-site instelling, anders de tagline van de site.
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
