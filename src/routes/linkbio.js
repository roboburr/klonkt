/**
 * Link-in-bio + klikstats (premium feature #6).
 *
 *   GET /links          -> Linktree-achtige pagina met de profile_links van de site
 *   GET /links/go/:i     -> telt de klik (per url) en stuurt door naar de externe URL
 *
 * Hergebruikt de bestaande sites.profile_links (JSON [{platform,url}]) + de
 * PLATFORMS-iconen/labels. Klikken landen in link_clicks (zie /admin/stats).
 * Open-redirect-veilig: /links/go/:i stuurt ALLEEN door naar een url die in de
 * eigen profile_links staat. Hub: via /user/:slug/links.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { PLATFORMS } from '../services/PlatformIcons.js';

const router = express.Router();

function parseLinks(site) {
  if (!site || !site.profile_links) return [];
  try { return JSON.parse(site.profile_links) || []; } catch { return []; }
}

router.get('/links', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const links = parseLinks(site).map((l, i) => {
    const meta = PLATFORMS[l.platform] || {};
    return { i, url: l.url, platform: l.platform, label: meta.label || l.platform, svg: meta.svg || '', brand: meta.brand || '' };
  });
  renderPage(req, res, 'pages/linkbio', {
    pageTitle: (site.title || '') + ' — links',
    bodyClass: 'on-linkbio',
    lbLinks: links,
  });
});

router.get('/links/go/:i', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const links = parseLinks(site);
  const idx = parseInt(req.params.i, 10);
  const link = (Number.isInteger(idx) && idx >= 0) ? links[idx] : null;
  if (!link || !link.url) return next();
  const url = String(link.url);
  // Alleen externe http(s)- of mailto-links (geen open redirect / javascript:).
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return res.status(400).send('Bad link');
  try {
    db.prepare(
      `INSERT INTO link_clicks (site_id, url, clicks, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(site_id, url) DO UPDATE SET clicks = clicks + 1, updated_at = CURRENT_TIMESTAMP`
    ).run(site.id, url);
  } catch { /* telling mag de redirect nooit breken */ }
  res.redirect(302, url);
});

export default router;
