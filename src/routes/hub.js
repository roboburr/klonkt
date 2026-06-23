/**
 * Hub home page — hub mode only. Instead of rendering the primary Klonkt site,
 * '/' renders a company overview here: the latest posts from ALL users combined
 * + a list of the Klonkt sites.
 *
 * In solo mode this does nothing (next()) and posts.js renders the single site.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { getTenancy, getSetting } from '../services/SettingsService.js';

const router = express.Router();

router.get('/', (req, res, next) => {
  if (getTenancy() !== 'hub') return next();
  // If resolveSite addressed a specific site (/user/:slug or /sites/:slug),
  // req.url was rewritten to '/' — do NOT show the overview but let posts.js
  // render the site itself. siteUrlBase is set in that case.
  if (res.locals.siteUrlBase) return next();

  // Latest published posts across all sites.
  const posts = db.prepare(`
    SELECT p.title, p.slug, p.excerpt, p.published_at, p.created_at,
           p.cover_image_url, p.type,
           s.slug AS site_slug, s.title AS site_title, s.profile_photo AS site_photo,
           u.username AS author_username
    FROM posts p
    JOIN sites s ON s.id = p.site_id
    LEFT JOIN users u ON u.id = p.author_id
    WHERE p.status = 'published'
    ORDER BY COALESCE(p.published_at, p.created_at) DESC
    LIMIT 24
  `).all();

  // The main/label site (the explicitly primary = the company/main account) is
  // NOT an artist; we display it separately at the top, not in the Artists roster.
  const mainSite = db.prepare(`
    SELECT s.id, s.slug, s.title, s.tagline, s.profile_photo, s.accent,
           u.avatar_url AS owner_avatar,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id AND status = 'published') AS post_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    WHERE s.is_primary = 1
    LIMIT 1
  `).get() || null;
  const mainId = mainSite ? mainSite.id : '';

  // Featured Klonkt sites for the home roster: most active first (number of
  // published posts), then newest. Excl. the main site. Capped at
  // HOME_ROSTER_LIMIT so the home scales — full list is at /leden.
  const HOME_ROSTER_LIMIT = 24;
  const artists = db.prepare(`
    SELECT s.slug, s.title, s.tagline, s.profile_photo, s.accent,
           u.avatar_url AS owner_avatar,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id AND status = 'published') AS post_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    WHERE s.id != @mainId
    ORDER BY post_count DESC, s.created_at DESC
    LIMIT @limit
  `).all({ mainId, limit: HOME_ROSTER_LIMIT });
  const totalArtists = db.prepare('SELECT COUNT(*) AS c FROM sites WHERE id != ?').get(mainId).c;

  // The hub page is GENERIC (not belonging to any user) — branding comes from global
  // settings managed by the admin in the admin panel, not from a site.
  const hub = {
    title: getSetting('hub_title') || 'Overzicht',
    tagline: getSetting('hub_tagline') || '',
    intro: getSetting('hub_intro') || '',
    heroImage: getSetting('hub_hero_image') || '',
    heroOverlay: (() => { const v = parseInt(getSetting('hub_hero_overlay'), 10); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 45; })(),
  };

  renderPage(req, res, 'pages/hub-home', {
    pageTitle: hub.title,
    socialDescr: hub.intro || hub.tagline || '',
    bodyClass: 'on-home on-hub',
    hub,
    mainSite,
    artists,
    totalArtists,
    rosterLimit: HOME_ROSTER_LIMIT,
    posts,
  });
});

export default router;
