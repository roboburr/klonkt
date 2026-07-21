/**
 * Paid posts (klonkt-demo-aki) slice 3: the patron link + passkey flow.
 * Cookie-less throughout: the OAuth state and the WebAuthn challenge travel in
 * signed blobs (CryptoBox), never a session.
 *
 * GET  /paid/link?post=<slug>  -> redirect to Patreon authorize
 * GET  /paid/callback          -> verify patron, render the passkey page
 * POST /paid/register          -> verify the passkey, store the entitlement
 */
import express from 'express';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { signBlob, verifyBlob, cryptoBoxReady } from '../services/CryptoBox.js';
import PaidPatreon from '../services/PaidPatreonService.js';
import Passkey from '../services/PasskeyService.js';
import { renderPostBodyHtml } from './posts.js';

const router = express.Router();
const AUTHORIZE = 'https://www.patreon.com/oauth2/authorize';

const baseUrl = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// The feature is only live when premium is on, secrets can be encrypted, and the
// owner has connected a campaign.
function ready(req, res) {
  const site = res.locals.site;
  if (!site) { res.status(404).end(); return null; }
  if (!premiumUnlocked() || !cryptoBoxReady()) { res.status(404).end(); return null; }
  const cfg = PaidPatreon.getOwnerConfig(site.id);
  if (!cfg || !cfg.clientId || !cfg.campaignId) { res.status(404).end(); return null; }
  return { site, cfg };
}

// Step 1: send the visitor to Patreon.
router.get('/link', (req, res) => {
  const r = ready(req, res); if (!r) return;
  const slug = String(req.query.post || '').trim();
  const post = slug ? db.prepare('SELECT slug, paid, paid_min_cents FROM posts WHERE site_id = ? AND slug = ?').get(r.site.id, slug) : null;
  if (!post || !post.paid) return res.redirect((res.locals.siteUrlBase || '') + '/' + (slug || ''));
  const cents = post.paid_min_cents || PaidPatreon.defaultMinCents(r.site.id);
  const state = signBlob({ purpose: 'patron', siteId: r.site.id, cents, post: post.slug }, 900);
  const url = `${AUTHORIZE}?response_type=code&client_id=${encodeURIComponent(r.cfg.clientId)}`
    + `&redirect_uri=${encodeURIComponent(baseUrl(req) + '/paid/callback')}`
    + `&scope=${encodeURIComponent('identity identity.memberships')}`
    + `&state=${encodeURIComponent(state)}`;
  res.redirect(url);
});

// Step 2: Patreon returns. Verify the patron; if a supporter at the right tier,
// render the passkey-creation page.
router.get('/callback', async (req, res) => {
  const r = ready(req, res); if (!r) return;
  const payload = verifyBlob(String(req.query.state || ''));
  if (!payload || payload.purpose !== 'patron' || payload.siteId !== r.site.id) {
    return res.status(400).send('Ongeldige of verlopen aanvraag. Probeer opnieuw vanaf de post.');
  }
  const code = String(req.query.code || '');
  if (req.query.error || !code) {
    return renderPage(req, res, 'pages/paid-result', { pageTitle: 'Ontgrendelen', bodyClass: 'on-special', ok: false, reason: 'declined', postSlug: payload.post });
  }
  const membership = await PaidPatreon.verifyPatron(r.site.id, code, baseUrl(req) + '/paid/callback').catch(() => null);
  const cents = membership ? (membership.cents || 0) : 0;
  const active = membership && membership.status === 'active_patron';
  if (!active || cents < payload.cents) {
    return renderPage(req, res, 'pages/paid-result', {
      pageTitle: 'Ontgrendelen', bodyClass: 'on-special', ok: false,
      reason: active ? 'tier' : 'notpatron', neededCents: payload.cents, haveCents: cents, postSlug: payload.post,
    });
  }
  // Supporter at the right tier. Hand out registration options + a signed blob
  // carrying the challenge and the proven cents; the passkey page returns both.
  const options = await Passkey.registrationOptions(baseUrl(req), r.site.slug);
  const blob = signBlob({ purpose: 'reg', siteId: r.site.id, cents, challenge: options.challenge }, 900);
  renderPage(req, res, 'pages/paid-passkey', {
    pageTitle: 'Maak je passkey', bodyClass: 'on-special',
    optionsJson: JSON.stringify(options), regBlob: blob, postSlug: payload.post,
  });
});

// Step 3: verify the passkey and store the pseudonymous entitlement.
router.post('/register', express.json({ limit: '64kb' }), async (req, res) => {
  const r = ready(req, res); if (!r) return res.status(404).json({ error: 'unavailable' });
  const { response, blob } = req.body || {};
  const payload = verifyBlob(String(blob || ''));
  if (!payload || payload.purpose !== 'reg' || payload.siteId !== r.site.id) {
    return res.status(400).json({ error: 'bad_challenge' });
  }
  const cred = await Passkey.verifyRegistration(baseUrl(req), response, payload.challenge);
  if (!cred) return res.status(400).json({ error: 'verify_failed' });
  Passkey.storeEntitlement({
    credentialId: cred.credentialId, siteId: r.site.id, publicKey: cred.publicKey,
    counter: cred.counter, transports: cred.transports, minCents: payload.cents,
  });
  res.json({ ok: true });
});

// Step 4 (unlock): hand out authentication options for a passkey assertion.
router.get('/challenge', async (req, res) => {
  const r = ready(req, res); if (!r) return;
  const slug = String(req.query.post || '').trim();
  const post = slug ? db.prepare('SELECT slug, paid, paid_min_cents FROM posts WHERE site_id = ? AND slug = ?').get(r.site.id, slug) : null;
  if (!post || !post.paid) return res.status(404).json({ error: 'not_paid' });
  const cents = post.paid_min_cents || PaidPatreon.defaultMinCents(r.site.id);
  const options = await Passkey.authenticationOptions(baseUrl(req));
  const blob = signBlob({ purpose: 'auth', siteId: r.site.id, cents, post: post.slug, challenge: options.challenge }, 300);
  res.json({ options, blob });
});

// Verify the assertion, check the entitlement, and return the full post body in
// the SAME response. No unlock token becomes state (design decision).
router.post('/unlock', express.json({ limit: '64kb' }), async (req, res) => {
  const r = ready(req, res); if (!r) return res.status(404).json({ error: 'unavailable' });
  const { response, blob } = req.body || {};
  const payload = verifyBlob(String(blob || ''));
  if (!payload || payload.purpose !== 'auth' || payload.siteId !== r.site.id) return res.status(400).json({ error: 'bad_challenge' });
  const credId = response && response.id;
  const ent = credId ? Passkey.getEntitlement(credId, r.site.id) : null;
  if (!ent) return res.status(403).json({ error: 'no_entitlement' });      // unknown/expired passkey
  if ((ent.min_cents || 0) < payload.cents) return res.status(403).json({ error: 'tier' });
  const vr = await Passkey.verifyAssertion(baseUrl(req), response, payload.challenge, ent);
  if (!vr) return res.status(400).json({ error: 'verify_failed' });
  Passkey.bumpCounter(credId, vr.newCounter);
  const post = db.prepare("SELECT * FROM posts WHERE site_id = ? AND slug = ? AND status = 'published'").get(r.site.id, String(payload.post || ''));
  if (!post || !post.paid) return res.status(404).json({ error: 'gone' });
  res.json({ ok: true, title: post.title || '', html: renderPostBodyHtml(r.site, post, req) });
});

export default router;
