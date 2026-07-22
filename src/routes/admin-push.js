/**
 * Admin: Notificaties (web push) — the owner's per-device toggle page.
 * Not premium-gated: notifications are infrastructure, not an extra.
 */
import express from 'express';
import { renderPage } from '../middleware/render.js';
import { requireSiteManager } from '../middleware/auth.js';
import Push from '../services/PushService.js';

const router = express.Router();

router.get('/', requireSiteManager, async (req, res) => {
  renderPage(req, res, 'pages/admin-push', {
    pageTitle: 'Notificaties',
    bodyClass: 'on-admin',
    vapidKey: await Push.publicKey(),          // null → feature unavailable
    subscriptions: Push.listSubscriptions(req.session.user.id),
    defaultAlerts: Push.DEFAULT_ALERTS,
  });
});

export default router;
