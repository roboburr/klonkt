// Paid posts (klonkt-demo-aki) slice 3: passkey registration + verification for
// pseudonymous entitlements. Uses @simplewebauthn/server. Cookie-less: the
// challenge is not kept in a session but travels inside a signed blob
// (CryptoBox.signBlob) that the client returns, so there is nothing to store
// between the two requests. An entitlement is {passkey, site, cents, expiry}
// with NO patron identity.
import crypto from 'crypto';
import db from '../config/database.js';

// Lazy so a not-yet-installed dependency can never crash app boot; only the
// paid passkey flow fails until `npm ci` has run.
let _lib = null;
async function lib() { if (!_lib) _lib = await import('@simplewebauthn/server'); return _lib; }

const DEFAULT_TTL_DAYS = 32;   // aligns with Patreon's monthly cycle; re-link after

// rpID is the site host; origin is the full base URL.
export function rpFor(base) {
  let host = ''; try { host = new URL(base).host.split(':')[0]; } catch { /* keep empty */ }
  return { rpID: host, origin: String(base).replace(/\/+$/, '') };
}

// Registration options for a fresh, discoverable (usernameless) passkey. The
// user handle is random: the credential is pseudonymous by design.
export async function registrationOptions(base, siteSlug) {
  const { rpID } = rpFor(base);
  const { generateRegistrationOptions } = await lib();
  return generateRegistrationOptions({
    rpName: `Supporter of ${siteSlug}`,
    rpID,
    userName: 'supporter',
    userDisplayName: 'Supporter',
    userID: crypto.randomBytes(16),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    timeout: 120000,
  });
}

// Verify a registration response against the challenge (read from the signed
// blob by the caller). Returns the credential to store, or null.
export async function verifyRegistration(base, response, expectedChallenge) {
  const { rpID, origin } = rpFor(base);
  let v;
  try {
    const { verifyRegistrationResponse } = await lib();
    v = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch { return null; }
  if (!v || !v.verified || !v.registrationInfo) return null;
  const cred = v.registrationInfo.credential;
  return {
    credentialId: cred.id,                                        // base64url string
    publicKey: Buffer.from(cred.publicKey).toString('base64url'), // COSE key bytes
    counter: cred.counter || 0,
    transports: response.response && response.response.transports ? JSON.stringify(response.response.transports) : null,
  };
}

// Authentication (assertion) options for the unlock. Discoverable credentials,
// so allowCredentials is empty and the browser offers the site's passkeys.
export async function authenticationOptions(base) {
  const { rpID } = rpFor(base);
  const { generateAuthenticationOptions } = await lib();
  return generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] });
}

// Verify an assertion against a stored entitlement row. Returns { newCounter }
// or null. Challenge is read from the signed blob by the caller.
export async function verifyAssertion(base, response, expectedChallenge, ent) {
  const { rpID, origin } = rpFor(base);
  let v;
  try {
    const { verifyAuthenticationResponse } = await lib();
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: ent.credential_id,
        publicKey: Buffer.from(ent.public_key, 'base64url'),
        counter: ent.counter || 0,
        transports: ent.transports ? JSON.parse(ent.transports) : undefined,
      },
    });
  } catch { return null; }
  if (!v || !v.verified) return null;
  return { newCounter: v.authenticationInfo.newCounter };
}

// Bump the signature counter after a successful assertion (clone detection).
export function bumpCounter(credentialId, newCounter) {
  db.prepare('UPDATE paid_entitlements SET counter = ? WHERE credential_id = ?').run(newCounter || 0, credentialId);
}

// Store (or refresh) a pseudonymous entitlement for this passkey.
export function storeEntitlement({ credentialId, siteId, publicKey, counter, transports, minCents, ttlDays = DEFAULT_TTL_DAYS }) {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  db.prepare(`INSERT INTO paid_entitlements
      (credential_id, site_id, public_key, counter, transports, min_cents, expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(credential_id) DO UPDATE SET
      public_key=excluded.public_key, counter=excluded.counter, transports=excluded.transports,
      min_cents=excluded.min_cents, expires_at=excluded.expires_at`)
    .run(credentialId, siteId, publicKey, counter || 0, transports || null, Math.max(0, minCents || 0), expiresAt);
  return expiresAt;
}

// A valid, unexpired entitlement for this passkey on this site, else null.
export function getEntitlement(credentialId, siteId) {
  const row = db.prepare('SELECT * FROM paid_entitlements WHERE credential_id = ? AND site_id = ?').get(credentialId, siteId);
  if (!row) return null;
  if ((row.expires_at || 0) < Math.floor(Date.now() / 1000)) return null;
  return row;
}

export function deleteEntitlement(credentialId) {
  return db.prepare('DELETE FROM paid_entitlements WHERE credential_id = ?').run(credentialId).changes > 0;
}

// Prune expired entitlements (Scheduler, slice 5).
export function pruneExpired() {
  return db.prepare('DELETE FROM paid_entitlements WHERE expires_at < ?').run(Math.floor(Date.now() / 1000)).changes;
}

export default {
  rpFor, registrationOptions, verifyRegistration, storeEntitlement,
  getEntitlement, deleteEntitlement, pruneExpired,
  authenticationOptions, verifyAssertion, bumpCounter,
};
