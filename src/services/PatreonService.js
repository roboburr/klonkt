// Patreon entitlement (premium layer).
//
// Model (Klonkt, 2026-06): the app + all updates are free. A set of premium
// extras (newsletter, download-for-email, release planning + fan-only posts,
// EPK/press kit, pro statistics, link-in-bio, embeddable player, show agenda)
// is gated behind a €14 lifetime Patreon supporter status. The central license
// server (license.klonkt.com)
// checks Patreon and signs an Ed25519 JWT "entitlement token". THIS instance
// verifies that token OFFLINE using the server's public key — a cracked/forked
// self-host cannot forge a valid token (only the license server can sign).
// That is the real lock; feature flags themselves can be patched on self-host
// (deliberately accepted: €14 < effort to crack).
//
// Premium is OFF by default (KLONKT_PREMIUM_ENABLED != 'on'): no premium UI
// is shown and nothing is gated. Self-hosters enable it once Patreon is set up.

import crypto from 'node:crypto';
import { getSetting, setSetting } from './SettingsService.js';

const LICENSE_URL = (process.env.KLONKT_LICENSE_URL || 'https://license.klonkt.com').replace(/\/$/, '');
const ISSUER = 'klonkt-license';

export function premiumEnabled() {
  return String(process.env.KLONKT_PREMIUM_ENABLED || '').toLowerCase() === 'on';
}
export function licenseBase() { return LICENSE_URL; }

// --- Cache the license-server public key (for offline verification) ---
let _pubKey = null;
async function licensePublicKey() {
  if (_pubKey) return _pubKey;
  const res = await fetch(`${LICENSE_URL}/pubkey`);
  if (!res.ok) throw new Error('pubkey fetch failed: ' + res.status);
  const pem = await res.text();
  _pubKey = crypto.createPublicKey(pem); // SPKI-PEM -> Ed25519 public key
  return _pubKey;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verify an entitlement token (EdDSA JWT from the license server). Throws on
// invalid signature, issuer, or expiry. Returns the claims on success.
export async function verifyEntitlementToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  if (header.alg !== 'EdDSA') throw new Error('unexpected alg');
  const key = await licensePublicKey();
  const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), key, b64urlToBuf(s));
  if (!ok) throw new Error('invalid signature');
  const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  if (payload.iss !== ISSUER) throw new Error('unexpected issuer');
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('expired token');
  return payload; // { sub, entitled, plan, lifetime_support_cents, exp, ... }
}

export function storeEntitlement(payload, token) {
  setSetting('patreon_entitled', payload.entitled ? '1' : '0');
  setSetting('patreon_sub', String(payload.sub || ''));
  setSetting('patreon_support_cents', String(payload.lifetime_support_cents || 0));
  setSetting('patreon_token_exp', String(payload.exp || 0));
  setSetting('patreon_token', token || '');
}

export function clearEntitlement() {
  for (const k of ['patreon_entitled', 'patreon_sub', 'patreon_support_cents', 'patreon_token_exp', 'patreon_token']) {
    setSetting(k, '');
  }
}

// Is this instance premium? Premium layer enabled + a valid, non-expired,
// entitled stored token. Patreon lifetime never decreases, so re-linking
// after expiry always succeeds.
export function isPremium() {
  if (!premiumEnabled()) return false;
  if (getSetting('patreon_entitled') !== '1') return false;
  const exp = Number(getSetting('patreon_token_exp', '0')) || 0;
  if (exp && exp * 1000 < Date.now()) return false;
  return true;
}

// Is a premium feature available? True if the premium layer is OFF (nothing is
// gated — current behavior), or ON and this instance is entitled. False only
// if premium is on but there is no valid Patreon connection (= paywall).
export function premiumUnlocked() {
  return !premiumEnabled() || isPremium();
}

export function entitlementStatus() {
  return {
    enabled: premiumEnabled(),
    premium: isPremium(),
    connected: getSetting('patreon_entitled') === '1',
    sub: getSetting('patreon_sub', '') || null,
    supportCents: Number(getSetting('patreon_support_cents', '0')) || 0,
    exp: Number(getSetting('patreon_token_exp', '0')) || 0,
  };
}
