// Patreon-entitlement (premium-laag).
//
// Model (Klonkt, 2026-06): de app + alle updates zijn gratis. Een paar premium-
// modules (Hub-modus, Statistieken, Fan-login) zitten achter een $10-lifetime
// Patreon-supporter-status. De centrale license-server (license.klonkt.com)
// checkt Patreon en tekent een Ed25519-JWT "entitlement-token". DEZE instance
// verifieert dat token OFFLINE met de publieke sleutel van de server — een
// gekraakte/geforkte self-host kan dus geen geldig token verzinnen (alleen de
// license-server kan tekenen). Dat is het echte slot; de feature-flags zelf zijn
// op self-host wel te patchen (bewust geaccepteerd: $10 < moeite om te kraken).
//
// Premium staat STANDAARD UIT (KLONKT_PREMIUM_ENABLED != 'on'): dan is er geen
// premium-UI en wordt er niets gegate. De self-hoster zet 'm aan zodra Patreon
// geregeld is.

import crypto from 'node:crypto';
import { getSetting, setSetting } from './SettingsService.js';

const LICENSE_URL = (process.env.KLONKT_LICENSE_URL || 'https://license.klonkt.com').replace(/\/$/, '');
const ISSUER = 'klonkt-license';

export function premiumEnabled() {
  return String(process.env.KLONKT_PREMIUM_ENABLED || '').toLowerCase() === 'on';
}
export function licenseBase() { return LICENSE_URL; }

// --- Publieke sleutel van de license-server cachen (voor offline verificatie) ---
let _pubKey = null;
async function licensePublicKey() {
  if (_pubKey) return _pubKey;
  const res = await fetch(`${LICENSE_URL}/pubkey`);
  if (!res.ok) throw new Error('pubkey fetch faalde: ' + res.status);
  const pem = await res.text();
  _pubKey = crypto.createPublicKey(pem); // SPKI-PEM -> Ed25519 public key
  return _pubKey;
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Verifieer een entitlement-token (EdDSA-JWT van de license-server). Gooit bij
// ongeldige handtekening/issuer/verlooptijd. Geeft de claims terug.
export async function verifyEntitlementToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  if (header.alg !== 'EdDSA') throw new Error('onverwacht alg');
  const key = await licensePublicKey();
  const ok = crypto.verify(null, Buffer.from(`${h}.${p}`), key, b64urlToBuf(s));
  if (!ok) throw new Error('ongeldige handtekening');
  const payload = JSON.parse(b64urlToBuf(p).toString('utf8'));
  if (payload.iss !== ISSUER) throw new Error('onverwachte issuer');
  if (payload.exp && payload.exp * 1000 < Date.now()) throw new Error('verlopen token');
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

// Is deze instance premium? Premium-laag aan + een geldig, niet-verlopen,
// entitled opgeslagen token. Patreon-lifetime daalt nooit, dus opnieuw koppelen
// na verloop slaagt altijd.
export function isPremium() {
  if (!premiumEnabled()) return false;
  if (getSetting('patreon_entitled') !== '1') return false;
  const exp = Number(getSetting('patreon_token_exp', '0')) || 0;
  if (exp && exp * 1000 < Date.now()) return false;
  return true;
}

// Is een premium-feature beschikbaar? True als de premium-laag UIT staat (dan is
// niets gegate — huidige gedrag), of AAN én deze instance is entitled. False alleen
// als premium aan staat maar er geen geldige Patreon-koppeling is (= betaalmuur).
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
