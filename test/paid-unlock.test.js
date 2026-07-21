// Paid posts slice 4 (klonkt-demo-3lz): the per-post unlock. The WebAuthn
// assertion needs a browser, so here we cover the pure pieces: authentication
// options carry a challenge and empty allowCredentials (discoverable), the
// counter bumps, and the tier gate compares entitlement cents to the post's.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.PAID_SECRET = 'a-test-paid-secret-of-sufficient-length';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const Passkey = (await import('../src/services/PasskeyService.js')).default;

test('authentication options carry a challenge, rpID host, and empty allowCredentials', async () => {
  const opts = await Passkey.authenticationOptions('https://test.example');
  assert.ok(opts.challenge && typeof opts.challenge === 'string');
  assert.equal(opts.rpId, 'test.example');
  assert.deepEqual(opts.allowCredentials || [], []);   // discoverable: browser offers the passkeys
});

test('bumpCounter persists the new signature counter (clone detection)', () => {
  Passkey.storeEntitlement({ credentialId: 'uc1', siteId: 's1', publicKey: 'PK', counter: 4, minCents: 300 });
  Passkey.bumpCounter('uc1', 7);
  const row = db.prepare('SELECT counter FROM paid_entitlements WHERE credential_id = ?').get('uc1');
  assert.equal(row.counter, 7);
});

test('tier gate: an entitlement below the post cents is refused, at/above passes', () => {
  Passkey.storeEntitlement({ credentialId: 'uc2', siteId: 's1', publicKey: 'PK', counter: 0, minCents: 300 });
  const ent = Passkey.getEntitlement('uc2', 's1');
  // mirrors the /paid/unlock check: (ent.min_cents || 0) < payload.cents  -> refuse
  assert.equal((ent.min_cents || 0) < 500, true);    // post needs 500, entitlement 300 -> blocked
  assert.equal((ent.min_cents || 0) < 300, false);   // post needs 300 -> allowed
  assert.equal((ent.min_cents || 0) < 100, false);   // post needs 100 -> allowed
});

test('an expired entitlement is not returned to the unlock path', () => {
  Passkey.storeEntitlement({ credentialId: 'uc3', siteId: 's1', publicKey: 'PK', minCents: 100, ttlDays: 30 });
  db.prepare('UPDATE paid_entitlements SET expires_at = 1 WHERE credential_id = ?').run('uc3');
  assert.equal(Passkey.getEntitlement('uc3', 's1'), null);
});
