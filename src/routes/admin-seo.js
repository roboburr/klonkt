/**
 * Admin: advanced SEO settings for the primary site.
 *
 * GET  /admin/seo   -> form with all SEO/social fields for the main site
 * POST /admin/seo   -> save (god-only)
 *
 * These fields are already consumed by the <head> (shell.ejs) and the JSON-LD/
 * OpenGraph tags, but were previously not editable anywhere. The basic
 * fields (title/bio/robots) remain in Appearance; this is the advanced layer:
 * title template, canonical, social share image, verification metas,
 * publisher/JSON-LD and OpenGraph locale.
 *
 * Operates on the PRIMARY site (solo = the only site; hub = the company site).
 */

import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { getPrimarySite } from '../middleware/site.js';

const router = express.Router();

function trimOrNull(v, max) {
  const s = (v == null ? '' : String(v)).trim();
  return s ? s.slice(0, max) : null;
}

// ==================== FORM ====================
router.get('/', requireGod, (req, res) => {
  const primary = getPrimarySite();
  if (!primary) {
    return res.redirect('/admin/sites/new?error=' + encodeURIComponent('Maak eerst een site aan'));
  }
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(primary.id);

  renderPage(req, res, 'pages/admin-seo', {
    pageTitleKey: 'admin.t_seo',
    bodyClass: 'on-admin',
    site,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

// ==================== SAVE ====================
router.post('/', requireGod, (req, res) => {
  const primary = getPrimarySite();
  if (!primary) return res.redirect('/admin/seo?error=' + encodeURIComponent('Geen site gevonden'));

  const f = req.body;
  const schemaType = f.schema_type === 'Organization' ? 'Organization' : 'Person';

  db.prepare(`
    UPDATE sites SET
      robots_index = ?,
      title_template = ?,
      canonical = ?,
      default_description = ?,
      og_image_default = ?,
      og_locale = ?,
      author = ?,
      twitter = ?,
      facebook_app_id = ?,
      google_verification = ?,
      bing_verification = ?,
      pinterest_verification = ?,
      yandex_verification = ?,
      schema_type = ?,
      publisher_name = ?,
      publisher_url = ?,
      publisher_logo = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    f.robots_index ? 1 : 0,
    (f.title_template || '{title} — {site}').slice(0, 200),
    trimOrNull(f.canonical, 200),
    trimOrNull(f.default_description, 500),
    trimOrNull(f.og_image_default, 500),
    trimOrNull(f.og_locale, 32),
    trimOrNull(f.author, 120),
    trimOrNull(f.twitter, 64),
    trimOrNull(f.facebook_app_id, 64),
    trimOrNull(f.google_verification, 200),
    trimOrNull(f.bing_verification, 200),
    trimOrNull(f.pinterest_verification, 200),
    trimOrNull(f.yandex_verification, 200),
    schemaType,
    trimOrNull(f.publisher_name, 200),
    trimOrNull(f.publisher_url, 200),
    trimOrNull(f.publisher_logo, 500),
    primary.id,
  );

  res.redirect('/admin/seo?success=' + encodeURIComponent('SEO-instellingen opgeslagen'));
});

export default router;
