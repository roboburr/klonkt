// Google-login via de centrale Klonkt-broker (license.klonkt.com).
//
// Deze instance praat NOOIT zelf met Google. De broker doet de OAuth-dans met één
// centrale Google-client en stuurt een kortlevend, gesigneerd identity-token terug;
// dat verifiëren we offline tegen de broker-pubkey. Zo hoeft geen enkele self-host
// een eigen Google-client aan te maken.
//
// Config via env:
//   KLONKT_BROKER_URL = https://license.klonkt.com
//   SITE_ORIGIN       = het eigen publieke origin (bv https://roboburr.com) —
//                       bepaalt de callback + de audience die we eisen.
//   ADMIN_EMAIL       = de Google-mail die owner/admin (god) is op deze instance.

import { importSPKI, jwtVerify } from 'jose';

const ALG = 'EdDSA';
const ISSUER = 'klonkt-license';

const BROKER_URL = (process.env.KLONKT_BROKER_URL || '').replace(/\/$/, '');
const SITE_ORIGIN = (process.env.SITE_ORIGIN || '').replace(/\/$/, '');

export function brokerConfigured() {
  return !!(BROKER_URL && SITE_ORIGIN);
}

// Waar de broker naartoe terugstuurt (moet in de broker-allowlist staan).
export function callbackUrl() {
  return `${SITE_ORIGIN}/auth/google/callback`;
}

export function brokerStartUrl(istate) {
  const p = new URLSearchParams({ return: callbackUrl(), istate });
  return `${BROKER_URL}/auth/google/start?${p.toString()}`;
}

// Broker-pubkey ophalen + cachen (bij fout NIET permanent cachen).
let _pubkeyPromise = null;
function getPublicKey() {
  if (!_pubkeyPromise) {
    _pubkeyPromise = (async () => {
      const r = await fetch(`${BROKER_URL}/pubkey`);
      if (!r.ok) throw new Error(`broker /pubkey faalde: ${r.status}`);
      return importSPKI(await r.text(), ALG);
    })().catch((e) => {
      _pubkeyPromise = null;
      throw e;
    });
  }
  return _pubkeyPromise;
}

// Verifieer het identity-token van de broker. Returnt de payload
// { typ:'identity', sub, email, name, picture, jti, exp, ... }.
export async function verifyIdentityToken(token) {
  const key = await getPublicKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    algorithms: [ALG],
    audience: SITE_ORIGIN, // token moet voor ÓNZE site bedoeld zijn
  });
  if (payload.typ !== 'identity') throw new Error('verkeerd tokentype');
  return payload;
}

// Kleine in-memory jti-cache tegen replay binnen de (korte) geldigheidsduur.
// Returnt false als de jti al gebruikt is.
const _usedJti = new Map(); // jti -> exp (epoch seconds)
export function consumeJti(jti, expEpoch) {
  if (!jti) return true; // geen jti = niets te dedupen
  const now = Math.floor(Date.now() / 1000);
  for (const [k, e] of _usedJti) if (e < now) _usedJti.delete(k);
  if (_usedJti.has(jti)) return false;
  _usedJti.set(jti, expEpoch || now + 600);
  return true;
}
