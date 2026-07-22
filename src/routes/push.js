/**
 * Web Push (docs/webpush-design.md) slice 2: enable/disable + test.
 * The public VAPID key is public by design (it only identifies this server to
 * the browser's push service); everything that touches a subscription is a
 * logged-in action. Web Push delivery itself is cookie-less.
 */
import express from 'express';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import Push from '../services/PushService.js';
import { t as i18nT, resolveLang } from '../services/i18n.js';

const router = express.Router();

// A subscription row is personal: only its creator may touch it.
function ownRow(endpoint, userId) {
  if (!endpoint) return null;
  const row = db.prepare('SELECT endpoint, user_id FROM push_subscriptions WHERE endpoint = ?').get(String(endpoint));
  return row && row.user_id === userId ? row : null;
}

router.get('/vapid', async (req, res) => {
  const key = await Push.publicKey();
  if (!key) return res.status(503).json({ error: 'push_unavailable' });
  res.json({ publicKey: key });
});

router.post('/subscribe', requireAuth, express.json({ limit: '16kb' }), async (req, res) => {
  if (!(await Push.pushReady())) return res.status(503).json({ error: 'push_unavailable' });
  const s = req.body && req.body.subscription;
  const keys = s && s.keys;
  const ok = Push.saveSubscription({
    endpoint: s && s.endpoint, userId: req.session.user.id,
    p256dh: keys && keys.p256dh, auth: keys && keys.auth,
    alertTypes: req.body.alerts || null,
    uaLabel: String(req.body.uaLabel || '').slice(0, 120) || null,
  });
  if (!ok) return res.status(400).json({ error: 'bad_subscription' });
  res.json({ ok: true });
});

router.post('/unsubscribe', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const row = ownRow(req.body && req.body.endpoint, req.session.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  Push.deleteSubscription(row.endpoint);
  res.json({ ok: true });
});

router.post('/alerts', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const row = ownRow(req.body && req.body.endpoint, req.session.user.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  Push.updateAlerts(row.endpoint, req.session.user.id, req.body.alerts || {});
  res.json({ ok: true });
});

// A test ping to all of the caller's own devices (bypasses alert prefs).
router.post('/test', requireAuth, async (req, res) => {
  const L = resolveLang(req);
  const sent = await Push.notifyUser(req.session.user.id, {
    type: 'test', title: i18nT(L, 'push.n_test_t'),
    body: i18nT(L, 'push.n_test_b'), url: '/admin/push',
  });
  res.json({ ok: true, sent });
});

export default router;
