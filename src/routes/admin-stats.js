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
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { getStats } from '../services/StatsService.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  if (!premiumUnlocked()) {
    return res.status(403).send('Statistieken is een premium-functie — koppel Patreon in Beheer → Instellingen.');
  }
  // Link-in-bio klikken (premium #6) voor de huidige site.
  let linkClicks = [];
  if (res.locals.site) {
    try {
      linkClicks = db.prepare(
        'SELECT url, clicks FROM link_clicks WHERE site_id = ? AND clicks > 0 ORDER BY clicks DESC LIMIT 50'
      ).all(res.locals.site.id);
    } catch { linkClicks = []; }
  }
  const days = [7, 14, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 14;
  renderPage(req, res, 'pages/admin-stats', {
    pageTitle: 'Statistieken',
    bodyClass: 'on-admin',
    stats: getStats(days),
    linkClicks,
  });
});

export default router;
