/**
 * Admin: globale instellingen — nu de tenancy-modus (Solo/Hub).
 *
 * GET  /admin/settings        -> toon huidige modus + uitleg
 * POST /admin/settings        -> sla modus op (god-only)
 *
 * Schakelen is niet-destructief: Solo verbergt alleen de multi-site-onderdelen
 * en routeert naar de primaire site; er wordt niets verwijderd.
 */

import express from 'express';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { getTenancy, setTenancy } from '../services/SettingsService.js';

const router = express.Router();

router.get('/', requireGod, (req, res) => {
  renderPage(req, res, 'pages/admin-settings', {
    pageTitle: 'Instellingen',
    bodyClass: 'on-admin',
    tenancy: getTenancy(),
    success: req.query.success || null,
  });
});

router.post('/', requireGod, (req, res) => {
  setTenancy(req.body.tenancy === 'hub' ? 'hub' : 'solo');
  res.redirect('/admin/settings?success=' + encodeURIComponent('Modus opgeslagen'));
});

export default router;
