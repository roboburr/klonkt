/**
 * GET /notifications — notifications page for the logged-in user.
 * Opening it marks everything as read (the counter in the header disappears).
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
