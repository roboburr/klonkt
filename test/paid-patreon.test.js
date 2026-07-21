// Paid posts slice 1 (klonkt-demo-aki): owner Patreon config is stored with the
// creator token encrypted at rest, and refreshes. In-memory SQLite.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.PAID_SECRET = 'a-test-paid-secret-of-sufficient-length';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const PP = (await import('../src/services/PaidPatreonService.js')).default;
const { encrypt, decrypt, signBlob, verifyBlob } = await import('../src/services/CryptoBox.js');

test('CryptoBox roundtrips and rejects tampering', () => {
  const c = encrypt('super-secret-token');
  assert.notEqual(c, 'super-secret-token');
  assert.equal(decrypt(c), 'super-secret-token');
  const parts = c.split(':'); parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(parts.join(':')));
});

test('signBlob/verifyBlob: valid passes, tampered and expired fail', () => {
  const t = signBlob({ site: 's1', purpose: 'link', cents: 500 }, 600);
  const p = verifyBlob(t);
  assert.equal(p.site, 's1'); assert.equal(p.purpose, 'link'); assert.equal(p.cents, 500);
  assert.equal(verifyBlob(t.slice(0, -2) + 'xx'), null);          // bad tag
  assert.equal(verifyBlob(signBlob({ x: 1 }, -1)), null);         // already expired
});

test('owner config stores the creator secret + token ENCRYPTED, never plaintext', () => {
  PP.saveOwnerConfig('s1', {
    clientId: 'cid', clientSecret: 'the-secret', campaignId: '42',
    accessToken: 'acc-token', refreshToken: 'ref-token',
    tokenExp: Math.floor(Date.now() / 1000) + 3600, defaultMinCents: 500,
  });
  // Raw DB row must not contain the plaintext secret/token.
  const raw = db.prepare('SELECT * FROM paid_patreon WHERE site_id = ?').get('s1');
  const dump = JSON.stringify(raw);
  assert.ok(!dump.includes('the-secret'), 'client secret leaked in plaintext');
  assert.ok(!dump.includes('acc-token'), 'access token leaked in plaintext');
  assert.ok(!dump.includes('ref-token'), 'refresh token leaked in plaintext');
  // But the service decrypts it back.
  const c = PP.getOwnerConfig('s1');
  assert.equal(c.clientSecret, 'the-secret');
  assert.equal(c.accessToken, 'acc-token');
  assert.equal(c.campaignId, '42');
  assert.equal(c.defaultMinCents, 500);
});

test('ownerStatus never exposes secrets', () => {
  const st = PP.ownerStatus('s1');
  assert.equal(st.configured, true);
  assert.equal(st.connected, true);
  assert.equal(JSON.stringify(st).includes('the-secret'), false);
  assert.equal(JSON.stringify(st).includes('acc-token'), false);
});

test('re-saving without a secret keeps the old one (no re-paste needed)', () => {
  PP.saveOwnerConfig('s1', { defaultMinCents: 999 });
  const c = PP.getOwnerConfig('s1');
  assert.equal(c.clientSecret, 'the-secret');   // preserved
  assert.equal(c.defaultMinCents, 999);         // updated
});

test('refreshCreatorToken stores the new token (encrypted) via injected fetch', async () => {
  let called = null;
  const fakeFetch = async (url, opts) => {
    called = { url, body: opts.body };
    return { ok: true, json: async () => ({ access_token: 'new-acc', refresh_token: 'new-ref', expires_in: 2592000 }) };
  };
  const ok = await PP.refreshCreatorToken('s1', fakeFetch);
  assert.equal(ok, true);
  assert.ok(called.url.includes('patreon.com'));
  assert.ok(called.body.includes('grant_type=refresh_token'));
  const c = PP.getOwnerConfig('s1');
  assert.equal(c.accessToken, 'new-acc');
  assert.equal(c.refreshToken, 'new-ref');
  // and still encrypted on disk
  const raw = db.prepare('SELECT access_token_enc FROM paid_patreon WHERE site_id = ?').get('s1');
  assert.ok(!raw.access_token_enc.includes('new-acc'));
});

test('needsRefresh true when near expiry, false when fresh', () => {
  PP.saveOwnerConfig('s2', { clientId: 'c', clientSecret: 's', refreshToken: 'r', accessToken: 'a', tokenExp: Math.floor(Date.now()/1000) + 60 });
  assert.equal(PP.needsRefresh('s2'), true);    // 60s < 1h skew
  PP.saveOwnerConfig('s2', { tokenExp: Math.floor(Date.now()/1000) + 7200 });
  assert.equal(PP.needsRefresh('s2'), false);
});
