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
import { isMbid } from '../services/ap-core.js';
import MusicBrainz from '../services/MusicBrainzService.js';

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
    pageJs: 'admin-seo',
    bodyClass: 'on-admin',
    site,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

/**
 * "Zoek jezelf op" -- kandidaten uit MusicBrainz (shaer-mbz).
 *
 * De zoekopdracht draait HIER en niet in de browser: MusicBrainz staat een
 * verzoek per seconde toe per APPLICATIE, en dat is alleen af te dwingen als
 * alles langs een plek gaat. Bovendien eisen ze een User-Agent met contact, en
 * die kan een browser niet zetten.
 *
 * Wij kiezen NIET. Ook niet als er precies een treffer is: een verkeerd geraden
 * MBID zet jouw naam onder andermans werk.
 */
router.get('/api/musicbrainz', requireGod, async (req, res) => {
  const site = getPrimarySite(req);
  const q = String(req.query.q || (site && (site.publisher_name || site.title)) || '').trim();
  if (!q) return res.json({ ok: true, q: '', kandidaten: [] });
  // Wie zijn id al kent plakt het hier. Een zoekopdracht op een UUID levert bij
  // MusicBrainz niets op, dus zonder deze tak geeft plakken juist het slechtste
  // resultaat.
  if (isMbid(q)) {
    const een = await MusicBrainz.haalArtiest(q);
    return res.json({ ok: true, q, kandidaten: een ? [een] : [] });
  }
  res.json({ ok: true, q, kandidaten: await MusicBrainz.zoekArtiesten(q) });
});

/**
 * De terug-weg: noemt de MusicBrainz-pagina ons domein? (shaer-mbz)
 *
 * Een koppeling van onze kant is een bewering -- iedereen kan een id typen.
 * Pas als de artiestenpagina TERUGWIJST is het een paar. Wij zetten die
 * verwijzing niet zelf: dat kan niet via hun API en hoort ook niet, de artiest
 * doet dat op musicbrainz.org onder "social networking".
 */
router.get('/api/musicbrainz/terugweg', requireGod, async (req, res) => {
  const mbid = String(req.query.mbid || '').trim().toLowerCase();
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!isMbid(mbid) || !base) return res.json({ ok: true, verified: false, urls: [] });
  res.json({ ok: true, ...(await MusicBrainz.controleerTerugweg(mbid, base)) });
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
      og_theme = ?,
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
      mb_artist_id = ?, mb_artist_name = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  // De MusicBrainz-koppeling (shaer-mbz). Alleen een echte MBID komt de kolom
  // in: zonder deze zeef sluipt er een URL of een handle in het veld dat naar
  // buiten gaat, en het gaat naar TWEE uitgangen -- de JSON-LD en de actor.
  // Leeg is een geldige keuze; dat is ontkoppelen.
  const mbRuw = String(f.mb_artist_id || '').trim().toLowerCase();
  const mbArtistId = isMbid(mbRuw) ? mbRuw : null;

  `).run(
    f.robots_index ? 1 : 0,
    (f.title_template || '{title} — {site}').slice(0, 200),
    trimOrNull(f.canonical, 200),
    trimOrNull(f.default_description, 500),
    trimOrNull(f.og_image_default, 500),
    (f.og_theme === 'light' || f.og_theme === 'dark') ? f.og_theme : null, // null = auto (follow site theme)
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
    mbArtistId,
    mbArtistId ? (String(f.mb_artist_name || '').trim().slice(0, 200) || null) : null,
    primary.id,
  );

  res.redirect('/admin/seo?success=' + encodeURIComponent('SEO-instellingen opgeslagen'));
});

export default router;
