/**
 * Admin: Cirkel-beheer (god-only).
 *   GET  /admin/circle           -> lijst van cirkel-links + status
 *   POST /admin/circle/add       -> Klonkt-URL toevoegen
 *   POST /admin/circle/:id/remove
 *   POST /admin/circle/:id/sync  -> nu verversen (pull + verifieer)
 *   POST /admin/circle/allow     -> toggle "mag in cirkels van anderen verschijnen"
 *
 * Zie docs/cirkels-v1-spec.md §5d.
 */

import express from 'express';
import crypto from 'crypto';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import db from '../config/database.js';
import { getTenancy } from '../services/SettingsService.js';
import { syncOne, sync } from '../services/CircleService.js';

const router = express.Router();

function primarySite() {
  return db.prepare('SELECT * FROM sites ORDER BY created_at ASC LIMIT 1').get();
}

router.get('/', requireGod, (req, res) => {
  const site = primarySite();
  const links = site
    ? db.prepare('SELECT * FROM circle_links WHERE local_site_id = ? ORDER BY added_at DESC').all(site.id)
    : [];
  const counts = {};
  for (const l of links) {
    counts[l.id] = l.remote_actor_id
      ? db.prepare('SELECT COUNT(*) AS n FROM remote_posts WHERE actor_id = ?').get(l.remote_actor_id).n
      : 0;
  }
  renderPage(req, res, 'pages/admin-circle', {
    pageTitle: 'Cirkel',
    bodyClass: 'on-admin',
    tenancy: getTenancy(),
    site,
    links,
    counts,
    allowCircle: site ? site.allow_circle !== 0 : true,
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

router.post('/add', requireGod, async (req, res) => {
  const site = primarySite();
  if (!site) return res.redirect('/admin/circle?error=' + encodeURIComponent('Geen site gevonden'));
  // Schema automatisch aanvullen: een kale domeinnaam → https://, een getypte
  // http:// → https:// (federatie is bewust https-only, getekende feeds). Zo hoeft
  // de gebruiker nooit zelf http(s):// te typen.
  let url = (req.body.remote_url || '').toString().trim().replace(/\/+$/, '');
  if (url && !/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  url = url.replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(url)) {
    return res.redirect('/admin/circle?error=' + encodeURIComponent('Voer een geldig site-adres in (bv. voorbeeld.nl)'));
  }
  const label = (req.body.label || '').toString().slice(0, 80).trim() || null;
  const id = crypto.randomUUID();
  try {
    db.prepare("INSERT INTO circle_links (id, local_site_id, remote_url, label, status) VALUES (?, ?, ?, ?, 'active')")
      .run(id, site.id, url, label);
  } catch (e) {
    return res.redirect('/admin/circle?error=' + encodeURIComponent('Deze site staat al in je cirkel'));
  }
  // Meteen ophalen i.p.v. wachten op de 15-min-loop.
  try {
    const link = db.prepare('SELECT * FROM circle_links WHERE id = ?').get(id);
    await syncOne(link);
    return res.redirect('/admin/circle?success=' + encodeURIComponent('Toegevoegd en gesynchroniseerd ✓'));
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 404 = geen cirkel-endpoint. Hubs federeren bewust NIET (hun /.klonkt/actor.json
    // geeft 404), net als losse niet-Klonkt-sites. Niet toevoegen: rol de insert terug
    // zodat er geen dode "fout"-rij in de cirkel blijft staan.
    if (/\b404\b/.test(msg)) {
      db.prepare('DELETE FROM circle_links WHERE id = ?').run(id);
      return res.redirect('/admin/circle?error=' + encodeURIComponent('Niet toegevoegd: deze site doet niet mee aan cirkels. Een hub kan geen cirkel-partner zijn (en losse/niet-Klonkt-sites ook niet).'));
    }
    // Andere (mogelijk tijdelijke) fout → link blijft staan; later "Verversen".
    return res.redirect('/admin/circle?success=' + encodeURIComponent('Toegevoegd — synchroniseren mislukte (klik "Verversen" om opnieuw te proberen)'));
  }
});

router.post('/:id/remove', requireGod, (req, res) => {
  const link = db.prepare('SELECT * FROM circle_links WHERE id = ?').get(req.params.id);
  if (link) {
    db.prepare('DELETE FROM circle_links WHERE id = ?').run(link.id);
    // Gecachte content opruimen als geen andere link nog naar deze actor wijst.
    if (link.remote_actor_id) {
      const other = db.prepare('SELECT 1 FROM circle_links WHERE remote_actor_id = ? LIMIT 1').get(link.remote_actor_id);
      if (!other) {
        db.prepare('DELETE FROM remote_posts WHERE actor_id = ?').run(link.remote_actor_id);
        db.prepare('DELETE FROM remote_actors WHERE id = ?').run(link.remote_actor_id);
      }
    }
  }
  res.redirect('/admin/circle?success=' + encodeURIComponent('Verwijderd'));
});

router.post('/:id/sync', requireGod, async (req, res) => {
  const link = db.prepare('SELECT * FROM circle_links WHERE id = ?').get(req.params.id);
  if (!link) return res.redirect('/admin/circle?error=' + encodeURIComponent('Niet gevonden'));
  try {
    const r = await syncOne(link);
    res.redirect('/admin/circle?success=' + encodeURIComponent(`Bijgewerkt — ${r.items} posts opgehaald`));
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300);
    db.prepare("UPDATE circle_links SET status='error', last_error=?, last_synced=CURRENT_TIMESTAMP WHERE id=?")
      .run(msg, link.id);
    res.redirect('/admin/circle?error=' + encodeURIComponent(msg));
  }
});

// Alles in één keer verversen (handig "voor de zekerheid").
router.post('/sync-all', requireGod, async (req, res) => {
  try {
    const r = await sync();
    const n = (r && r.results) ? r.results.filter((x) => x && x.ok).length : 0;
    res.redirect('/admin/circle?success=' + encodeURIComponent(`Cirkel gesynchroniseerd (${n} site(s) bijgewerkt)`));
  } catch (e) {
    res.redirect('/admin/circle?error=' + encodeURIComponent(String((e && e.message) || e).slice(0, 200)));
  }
});

router.post('/allow', requireGod, (req, res) => {
  const site = primarySite();
  if (site) {
    const v = (req.body.allow_circle === 'on' || req.body.allow_circle === '1') ? 1 : 0;
    db.prepare('UPDATE sites SET allow_circle = ? WHERE id = ?').run(v, site.id);
  }
  res.redirect('/admin/circle?success=' + encodeURIComponent('Opgeslagen'));
});

export default router;
