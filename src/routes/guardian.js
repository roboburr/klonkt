/**
 * The Guardian PWA (FEP-633c): a separate, installable corner of Klonkt for
 * guardians. One place to add and manage wards, a message centre for
 * incoming help requests and adoption traffic, and its own push channel
 * (alert types 'help' and 'guardian', web-push slice reused).
 *
 * Everything is scoped to a site the logged-in user OWNS: the guardian acts
 * as one of their own actors (?site=slug picks one when they own several).
 * Views carry no inline scripts (CSP): logic lives in /assets/js/guardian.js.
 */
import express from 'express';
import db from '../config/database.js';
import { requireAuth } from '../middleware/auth.js';
import AP from '../services/ActivityPubService.js';
import * as Guardianship from '../services/guardianship/index.js';
import { t as i18nT, resolveLang } from '../services/i18n.js';

const router = express.Router();

/** The acting site: ?site=slug when owned, else the user's first site. */
function siteForUser(req) {
  const userId = req.session.user.id;
  const want = String(req.query.site || req.body?.site || '').trim();
  if (want) {
    const s = db.prepare('SELECT * FROM sites WHERE slug = ? AND owner_id = ?').get(want, userId);
    if (s) return s;
  }
  return db.prepare('SELECT * FROM sites WHERE owner_id = ? ORDER BY id LIMIT 1').get(userId);
}

/** Everything the dashboard shows, one shape for page and API. */
function uiStrings(L) {
  const keys = ['sent', 'sent_retry', 'sending', 'not_found', 'failed', 'network',
    'pending', 'active', 'retract', 'release', 'open', 'push_unavailable'];
  return Object.fromEntries(keys.map((k) => [k, i18nT(L, `guardian.${k}`)]));
}

function dashboardState(site, L) {
  const wards = Guardianship.listWards(site.slug);
  const help = db.prepare(
    `SELECT object_uri, note_url, actor_uri, actor_name, actor_handle, actor_icon, content, published, created_at
     FROM ap_mentions WHERE slug = ? AND help_request = 1 ORDER BY created_at DESC LIMIT 50`
  ).all(site.slug);
  return {
    site: site.slug,
    wards: wards.filter((w) => w.status === 'accepted'),
    pendingOffers: wards.filter((w) => w.status === 'offered'),
    help,
    strings: uiStrings(L),
  };
}

// ── The PWA page ─────────────────────────────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const site = siteForUser(req);
  const L = resolveLang(req);
  if (!site) return res.status(404).send('No site for this account.');
  const sites = db.prepare('SELECT slug, title FROM sites WHERE owner_id = ? ORDER BY id').all(req.session.user.id);
  res.render('pages/guardian', {
    state: dashboardState(site, L),
    sites,
    lang: L,
    t: (k, v) => i18nT(L, k, v),
    cspNonce: res.locals.cspNonce,
  });
});

// ── JSON state for refreshes ─────────────────────────────────────────────
router.get('/api/state', requireAuth, (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  res.json(dashboardState(site, resolveLang(req)));
});

// ── Adopt a ward: handle → resolve → C2S Offer through the same pipeline
//    the Shaer apps use (one path, one behavior).
router.post('/adopt', requireAuth, express.json({ limit: '4kb' }), async (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const handle = String(req.body?.handle || '').trim();
  if (!handle) return res.status(400).json({ error: 'empty_handle' });
  const wardUri = /^https?:\/\//i.test(handle) ? handle : await AP.webfingerResolve(handle).catch(() => null);
  if (!wardUri) return res.status(404).json({ error: 'not_found' });   // the handle does not resolve to an account
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  const me = AP.actorId(base, site.slug);
  const r = await AP.ingestOutboxActivity(site, req.session.user, {
    type: 'Offer',
    object: { type: 'Relationship', subject: wardUri, relationship: 'shaer:Guardian', object: me },
  });
  // 403/400 = a real refusal (e.g. you are a ward yourself); anything else the
  // offer is recorded and delivery is retried in the background.
  if (!r || (r.status >= 400 && r.status !== 502)) return res.status(r?.status || 500).json({ error: r?.error || 'offer_failed' });
  res.json({ ok: true, ward: wardUri, delivered: r.delivered !== false });
});

// ── Manage: retract a pending offer / release a ward ─────────────────────
router.post('/wards/remove', requireAuth, express.json({ limit: '4kb' }), (req, res) => {
  const site = siteForUser(req);
  if (!site) return res.status(404).json({ error: 'no_site' });
  const uri = String(req.body?.uri || '').trim();
  if (!uri) return res.status(400).json({ error: 'empty_uri' });
  Guardianship.removeRelation(site.slug, 'guardian', uri);
  res.json({ ok: true });
});

// ── The installable identity: own scope so the Guardian corner installs as
//    its own app next to the site PWA.
router.get('/manifest.webmanifest', (req, res) => {
  const site = res.locals.site;
  res.set('Cache-Control', 'no-cache');
  res.json({
    id: `klonkt-guardian-${site?.slug || 'guardian'}`,
    name: 'Klonkt Guardian',
    short_name: 'Guardian',
    description: 'Ward management and help requests for guardians.',
    scope: '/guardian/',
    start_url: '/guardian?source=pwa',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    orientation: 'any',
    background_color: '#141a24',
    theme_color: '#ff6b35',
    lang: site?.language || 'nl',
    icons: [
      { src: '/guardian/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  });
});

// The buoy mark, in the guardian accent (mirrors the site favicon pattern).
router.get('/icon.svg', (req, res) => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#ff6b35"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-size="36">&#128735;</text>
</svg>`;
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(svg);
});

export default router;
