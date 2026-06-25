/**
 * Admin: Link Patreon for the premium layer (god-only).
 *
 * GET /admin/patreon/connect    -> redirect the admin to the license server
 *                                  (oauth/start) with our callback as return URL.
 * GET /admin/patreon/callback   -> license server returns with ?klonkt_token
 *                                  (or ?klonkt_error). Verify + store.
 * GET /admin/patreon/disconnect -> clear entitlement.
 *
 * The real monetisation lock is in the signed token (only the
 * license server can sign). See PatreonService.js.
 */

import express from 'express';
import { requireGod } from '../middleware/auth.js';
import {
  licenseBase, premiumEnabled, verifyEntitlementToken, storeEntitlement, clearEntitlement,
} from '../services/PatreonService.js';

const router = express.Router();
router.use(requireGod);

function baseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

router.get('/connect', (req, res) => {
  if (!premiumEnabled()) return res.redirect('/admin/settings');
  const ret = baseUrl(req) + '/admin/patreon/callback';
  res.redirect(`${licenseBase()}/oauth/start?return=${encodeURIComponent(ret)}`);
});

router.get('/callback', async (req, res) => {
  if (!premiumEnabled()) return res.redirect('/admin/settings');
  const { klonkt_token, klonkt_error, klonkt_support_cents } = req.query;
  if (klonkt_error) {
    const cents = Number(klonkt_support_cents || 0);
    const msg = klonkt_error === 'not_entitled'
      ? `Patreon gekoppeld, maar nog geen €14 (≈ $16) lifetime (nu ${(cents / 100).toFixed(2)} aan steun). Steun de campagne en koppel opnieuw.`
      : 'Patreon-koppeling mislukt.';
    return res.redirect('/admin/settings?error=' + encodeURIComponent(msg));
  }
  try {
    const payload = await verifyEntitlementToken(String(klonkt_token || ''));
    if (!payload.entitled) throw new Error('not entitled');
    storeEntitlement(payload, String(klonkt_token));
    res.redirect('/admin/settings?success=' + encodeURIComponent('Patreon gekoppeld — premium is actief.'));
  } catch (e) {
    console.error('[patreon/callback]', e.message);
    res.redirect('/admin/settings?error=' + encodeURIComponent('Patreon-token kon niet geverifieerd worden.'));
  }
});

router.get('/disconnect', (req, res) => {
  clearEntitlement();
  res.redirect('/admin/settings?success=' + encodeURIComponent('Patreon ontkoppeld.'));
});

export default router;
