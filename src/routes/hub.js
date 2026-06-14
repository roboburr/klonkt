/**
 * Hub-hoofdpagina — alleen in hub-modus. In plaats van de primaire PrutFolio te
 * tonen, rendert '/' hier een bedrijfs-overview: de laatste posts van ALLE
 * gebruikers samengevat + een lijst van de PrutFolio's.
 *
 * In solo-modus doet dit niets (next()) en rendert posts.js de enige site.
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { getTenancy } from '../services/SettingsService.js';

const router = express.Router();

router.get('/', (req, res, next) => {
  if (getTenancy() !== 'hub') return next();

  // Laatste gepubliceerde posts over álle sites heen.
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

  // De PrutFolio's (sites) voor de gebruikers-lijst.
  const sites = db.prepare(`
    SELECT s.slug, s.title, s.profile_photo,
           u.username AS owner_username,
           (SELECT COUNT(*) FROM posts WHERE site_id = s.id AND status = 'published') AS post_count
    FROM sites s
    LEFT JOIN users u ON u.id = s.owner_id
    ORDER BY s.created_at ASC
  `).all();

  // De primaire/oudste site geldt als de bedrijfssite (label). De roster toont
  // alleen de artiesten (alle overige sites), niet de bedrijfssite zelf.
  const company = res.locals.site || null;
  const artists = company ? sites.filter((s) => s.slug !== company.slug) : sites;

  renderPage(req, res, 'pages/hub-home', {
    pageTitle: company ? company.title : 'Overzicht',
    socialDescr: (company && (company.description || company.tagline)) || '',
    bodyClass: 'on-home on-hub',
    company,
    artists,
    posts,
  });
});

export default router;
