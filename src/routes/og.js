/**
 * GET /og/:slug.png — themed Open Graph card for a site (1200x630 PNG).
 * Generated from the site's palette + accent (see OgImageService), cached.
 * Used as the default og:image so every site has a branded social preview.
 */
import express from 'express';
import db from '../config/database.js';
import { ogImageFor } from '../services/OgImageService.js';

const router = express.Router();

router.get('/:slug.png', (req, res) => {
  let site;
  try {
    site = db.prepare(
      'SELECT slug, title, tagline, description, palette, accent FROM sites WHERE slug = ?'
    ).get(req.params.slug);
  } catch { /* db error → 404 below */ }
  if (!site) return res.status(404).end();

  const png = ogImageFor(site);
  if (!png) return res.status(404).end(); // resvg unavailable → no card (graceful)

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(png);
});

export default router;
