/**
 * GET /notifications — meldingenpagina voor de ingelogde gebruiker.
 * Openen = alles als gelezen markeren (de teller in de header valt dan weg).
 */
import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { renderPage } from '../middleware/render.js';
import { list, markAllRead } from '../services/NotificationService.js';

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const uid = req.session.user.id;
  const items = list(uid, 50);
  markAllRead(uid);
  renderPage(req, res, 'pages/notifications', {
    pageTitle: 'Meldingen',
    bodyClass: 'on-special',
    items,
  });
});

export default router;
