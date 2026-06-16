/**
 * Admin: Statistieken (premium-module, god-only).
 *
 * GET /admin/stats -> cookievrije statistieken: bezoekers/weergaven per dag,
 *                     plays, en de populairste posts/tracks.
 *
 * Premium-gated via premiumUnlocked() (premium-laag uit = gewoon beschikbaar;
 * aan = Patreon vereist). Tracking zit in StatsService (geen cookies).
 */

import express from 'express';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { getStats } from '../services/StatsService.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  if (!premiumUnlocked()) {
    return res.status(403).send('Statistieken is een premium-functie — koppel Patreon in Beheer → Instellingen.');
  }
  renderPage(req, res, 'pages/admin-stats', {
    pageTitle: 'Statistieken',
    bodyClass: 'on-admin',
    stats: getStats(14),
  });
});

export default router;
