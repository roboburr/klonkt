/**
 * Link-in-bio + click stats (premium feature #6).
 *
 *   GET /links          -> Linktree-style page with the site's profile_links
 *   GET /links/go/:i     -> counts the click (per url) and redirects to the external URL
 *
 * Reuses the existing sites.profile_links (JSON [{platform,url}]) + the
 * PLATFORMS icons/labels. Clicks are stored in link_clicks (see /admin/stats).
 * Open-redirect safe: /links/go/:i ONLY redirects to a url present in the
 * site's own profile_links. Hub: via /user/:slug/links.
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
  // Only external http(s) or mailto links (no open redirect / javascript:).
  if (!/^https?:\/\//i.test(url) && !/^mailto:/i.test(url)) return res.status(400).send('Bad link');
  try {
    db.prepare(
      `INSERT INTO link_clicks (site_id, url, clicks, updated_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(site_id, url) DO UPDATE SET clicks = clicks + 1, updated_at = CURRENT_TIMESTAMP`
    ).run(site.id, url);
  } catch { /* counting must never break the redirect */ }
  res.redirect(302, url);
});

export default router;
