/**
 * Admin: Statistics (premium module, god-only).
 *
 * GET /admin/stats -> cookie-free statistics: visitors/views per day,
 *                     plays, and the most popular posts/tracks.
 *
 * Premium-gated via premiumUnlocked() (premium layer off = freely available;
 * on = Patreon required). Tracking is in StatsService (no cookies).
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { getStats, currentIp, getExcludedIps, setExcludedIps } from '../services/StatsService.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  if (!premiumUnlocked()) {
    return res.status(403).send('Statistieken is een premium-functie — koppel Patreon in Beheer → Instellingen.');
  }
  // Link-in-bio clicks (premium #6) for the current site.
  let linkClicks = [];
  if (res.locals.site) {
    try {
      linkClicks = db.prepare(
        'SELECT url, clicks FROM link_clicks WHERE site_id = ? AND clicks > 0 ORDER BY clicks DESC LIMIT 50'
      ).all(res.locals.site.id);
    } catch { linkClicks = []; }
  }
  const days = [7, 14, 30, 90].includes(parseInt(req.query.days, 10)) ? parseInt(req.query.days, 10) : 14;
  const myIp = currentIp(req);
  renderPage(req, res, 'pages/admin-stats', {
    pageTitleKey: 'admin.t_stats',
    bodyClass: 'on-admin',
    stats: getStats(days),
    linkClicks,
    myIp,
    ipExcluded: !!myIp && getExcludedIps().includes(myIp),
  });
});

// Toggle whether the admin's current IP is counted in statistics.
router.post('/exclude-ip', requireGod, (req, res) => {
  const ip = currentIp(req);
  if (ip) {
    const list = getExcludedIps();
    const i = list.indexOf(ip);
    if (i >= 0) list.splice(i, 1); else list.push(ip);
    setExcludedIps(list);
  }
  res.redirect('/admin/stats');
});

export default router;
