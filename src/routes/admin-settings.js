/**
 * Admin: globale instellingen.
 *  - tenancy-modus (Solo/Hub)
 *  - hub-branding (naam/tagline/intro van de generieke hub-hoofdpagina)
 *
 * GET  /admin/settings   -> toon huidige instellingen
 * POST /admin/settings   -> sla op (god-only)
 *
 * De hub-pagina is generiek (van geen enkele user); deze branding leeft in
 * globale settings, niet in een site.
 */

import express from 'express';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { getTenancy, setTenancy, getSetting, setSetting } from '../services/SettingsService.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  renderPage(req, res, 'pages/admin-settings', {
    pageTitle: 'Instellingen',
    bodyClass: 'on-admin',
    tenancy: getTenancy(),
    hubTitle: getSetting('hub_title') || '',
    hubTagline: getSetting('hub_tagline') || '',
    hubIntro: getSetting('hub_intro') || '',
    hubHeroImage: getSetting('hub_hero_image') || '',
    success: req.query.success || null,
  });
});

router.post('/', requireGod, (req, res) => {
  if (typeof req.body.tenancy !== 'undefined') {
    setTenancy(req.body.tenancy === 'hub' ? 'hub' : 'solo');
  }
  if (typeof req.body.hub_title !== 'undefined') {
    setSetting('hub_title', (req.body.hub_title || '').toString().slice(0, 80).trim());
  }
  if (typeof req.body.hub_tagline !== 'undefined') {
    setSetting('hub_tagline', (req.body.hub_tagline || '').toString().slice(0, 120).trim());
  }
  if (typeof req.body.hub_intro !== 'undefined') {
    setSetting('hub_intro', (req.body.hub_intro || '').toString().slice(0, 400).trim());
  }
  if (typeof req.body.hub_hero_image !== 'undefined') {
    setSetting('hub_hero_image', (req.body.hub_hero_image || '').toString().slice(0, 300).trim());
  }
  res.redirect('/admin/settings?success=' + encodeURIComponent('Opgeslagen'));
});

export default router;
