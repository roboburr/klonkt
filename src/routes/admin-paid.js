/**
 * Admin: Paid posts (premium module, god-only). Slice 1 of klonkt-demo-aki.
 *
 * GET  /admin/paid          -> the owner's Patreon config form + status
 * POST /admin/paid          -> save config (secret/token stored encrypted)
 * POST /admin/paid/disconnect -> forget the config
 *
 * Premium-gated via premiumUnlocked(), like stats/downloads. This is the site
 * owner's OWN Patreon campaign, separate from Klonkt Premium's license flow.
 */
import express from 'express';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { cryptoBoxReady } from '../services/CryptoBox.js';
import PaidPatreon from '../services/PaidPatreonService.js';

const router = express.Router();

// The redirect URI the owner MUST whitelist in their Patreon client. Must match
// exactly what paid.js sends, or Patreon shows its own error page (which we
// cannot skin) instead of returning the visitor to us.
const redirectUri = (req) =>
  (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '') + '/paid/callback';

function gate(req, res) {
  if (!premiumUnlocked()) {
    res.status(403).send('Betaalde posts is een premium-functie: koppel Patreon in Beheer, Instellingen.');
    return false;
  }
  if (!res.locals.site) { res.status(400).send('Geen site.'); return false; }
  return true;
}

router.get('/', requireGod, (req, res) => {
  if (!gate(req, res)) return;
  renderPage(req, res, 'pages/admin-paid', {
    pageTitle: 'Betaalde posts',
    bodyClass: 'on-admin',
    status: PaidPatreon.ownerStatus(res.locals.site.id),
    secretReady: cryptoBoxReady(),
    redirectUri: redirectUri(req),
    saved: req.query.saved === '1',
    error: req.query.error || null,
  });
});

router.post('/', requireGod, (req, res) => {
  if (!gate(req, res)) return;
  if (!cryptoBoxReady()) return res.redirect('/admin/paid?error=' + encodeURIComponent('De encryptiesleutel kon niet worden aangemaakt of gelezen (schrijfrechten op de opslagmap?); secrets kunnen niet veilig worden opgeslagen.'));
  const b = req.body || {};
  const eur = String(b.default_min_eur || '').replace(',', '.').trim();
  const cents = eur ? Math.round(parseFloat(eur) * 100) : undefined;
  try {
    PaidPatreon.saveOwnerConfig(res.locals.site.id, {
      clientId: (b.client_id || '').trim() || undefined,
      // Empty secret/token fields keep the stored value (no re-paste needed).
      clientSecret: (b.client_secret || '').trim() || undefined,
      campaignId: (b.campaign_id || '').trim() || undefined,
      accessToken: (b.access_token || '').trim() || undefined,
      refreshToken: (b.refresh_token || '').trim() || undefined,
      // Empty clears it (null), a value sets it. Unlike secrets, this is not
      // sensitive and there's a clear "remove the link" intent.
      patreonUrl: (b.patreon_url || '').trim() || null,
      defaultMinCents: Number.isFinite(cents) ? cents : undefined,
    });
    return res.redirect('/admin/paid?saved=1');
  } catch (e) {
    return res.redirect('/admin/paid?error=' + encodeURIComponent(e.message || 'Opslaan mislukt'));
  }
});

router.post('/disconnect', requireGod, (req, res) => {
  if (!gate(req, res)) return;
  PaidPatreon.disconnect(res.locals.site.id);
  res.redirect('/admin/paid?saved=1');
});

export default router;
