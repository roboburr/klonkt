// Paid posts slice 3 (klonkt-demo-aki): patron verification + pseudonymous
// passkey entitlements. The WebAuthn ceremony itself needs a browser, so here
// we cover the pure parsing, the Patreon exchange (mock fetch), the entitlement
// store, and that registration options carry a challenge.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.PAID_SECRET = 'a-test-paid-secret-of-sufficient-length';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const PP = (await import('../src/services/PaidPatreonService.js')).default;
const Passkey = (await import('../src/services/PasskeyService.js')).default;

PP.saveOwnerConfig('s1', { clientId: 'cid', clientSecret: 'sec', campaignId: '42', defaultMinCents: 300 });

const identityWith = (campaignId, status, cents) => ({
  data: { type: 'user', id: 'u', relationships: { memberships: { data: [{ type: 'member', id: 'm1' }] } } },
  included: [
    { type: 'member', id: 'm1', attributes: { patron_status: status, currently_entitled_amount_cents: cents },
      relationships: { campaign: { data: { type: 'campaign', id: campaignId } } } },
    { type: 'campaign', id: campaignId },
  ],
});

test('pickCampaignMembership: exact campaign match wins', async () => {
  const { pickCampaignMembership } = await import('../src/services/PaidPatreonService.js');
  const id = identityWith('42', 'active_patron', 500);
  const m = pickCampaignMembership(id, '42');
  assert.equal(m.status, 'active_patron');
  assert.equal(m.cents, 500);
});

test('pickCampaignMembership: sole membership is used even if campaign_id is wrong (creator-scoped)', async () => {
  const { pickCampaignMembership } = await import('../src/services/PaidPatreonService.js');
  const id = identityWith('42', 'active_patron', 500);
  // A typo'd campaign_id must not lock out a real patron: memberships from the
  // owner's own client are already their campaign, so fall back to the sole one.
  const m = pickCampaignMembership(id, '999');
  assert.equal(m.status, 'active_patron');
  assert.equal(m.cents, 500);
});

test('pickCampaignMembership: multiple memberships + no match → null (no silent grant)', async () => {
  const { pickCampaignMembership } = await import('../src/services/PaidPatreonService.js');
  const id = {
    data: { type: 'user', id: 'u', relationships: { memberships: { data: [{ type: 'member', id: 'm1' }, { type: 'member', id: 'm2' }] } } },
    included: [
      { type: 'member', id: 'm1', attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 300 }, relationships: { campaign: { data: { type: 'campaign', id: '42' } } } },
      { type: 'member', id: 'm2', attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 800 }, relationships: { campaign: { data: { type: 'campaign', id: '77' } } } },
    ],
  };
  assert.equal(pickCampaignMembership(id, '999'), null);      // ambiguous, refuse
  assert.equal(pickCampaignMembership(id, '77').cents, 800);  // exact still works
});

test('pickCampaignMembership: no memberships → null', async () => {
  const { pickCampaignMembership } = await import('../src/services/PaidPatreonService.js');
  assert.equal(pickCampaignMembership({ data: {}, included: [] }, '42'), null);
});

test('verifyPatron exchanges the code and reads the membership (mock fetch)', async () => {
  const calls = [];
  const fetchMock = async (url, opts) => {
    calls.push(url);
    if (url.includes('/token')) return { ok: true, json: async () => ({ access_token: 'patron-tok' }) };
    return { ok: true, json: async () => identityWith('42', 'active_patron', 800) };
  };
  const m = await PP.verifyPatron('s1', 'the-code', 'https://test.example/paid/callback', fetchMock);
  assert.equal(m.status, 'active_patron');
  assert.equal(m.cents, 800);
  assert.ok(calls[0].includes('patreon.com'));
  assert.ok(calls[1].includes('identity'));
});

test('registration options carry a challenge and the site host as rpID', async () => {
  const opts = await Passkey.registrationOptions('https://test.example', 's1');
  assert.ok(opts.challenge && typeof opts.challenge === 'string');
  assert.equal(opts.rp.id, 'test.example');
  assert.equal(opts.authenticatorSelection.residentKey, 'required');
});

test('entitlement stores, reads, expires, prunes; no patron identity present', () => {
  Passkey.storeEntitlement({ credentialId: 'cred1', siteId: 's1', publicKey: 'PUBKEY', counter: 0, minCents: 500, ttlDays: 30 });
  const e = Passkey.getEntitlement('cred1', 's1');
  assert.ok(e);
  assert.equal(e.min_cents, 500);
  // the row has no name/email/patreon id
  const cols = Object.keys(e);
  assert.ok(!cols.some((c) => /name|email|patron|user/i.test(c)), 'no identity columns');
  // expired entitlement is not returned and gets pruned
  Passkey.storeEntitlement({ credentialId: 'cred2', siteId: 's1', publicKey: 'PK', minCents: 100, ttlDays: 30 });
  db.prepare('UPDATE paid_entitlements SET expires_at = 1 WHERE credential_id = ?').run('cred2');
  assert.equal(Passkey.getEntitlement('cred2', 's1'), null);
  assert.equal(Passkey.pruneExpired() >= 1, true);
  assert.ok(Passkey.getEntitlement('cred1', 's1'));   // the fresh one survives
});

test('patreonUrl: set, kept on unrelated save, cleared on empty', () => {
  PP.saveOwnerConfig('s2', { clientId: 'c', clientSecret: 's', campaignId: '7', patreonUrl: 'https://patreon.com/x' });
  assert.equal(PP.patreonUrl('s2'), 'https://patreon.com/x');
  // a save that does NOT mention patreonUrl (e.g. token refresh) keeps it
  PP.saveOwnerConfig('s2', { defaultMinCents: 200 });
  assert.equal(PP.patreonUrl('s2'), 'https://patreon.com/x');
  // an explicit empty value clears it
  PP.saveOwnerConfig('s2', { patreonUrl: '' });
  assert.equal(PP.patreonUrl('s2'), null);
});

test('deleteEntitlement removes the row (forget-passkey path)', () => {
  Passkey.storeEntitlement({ credentialId: 'cred3', siteId: 's1', publicKey: 'PK', minCents: 100 });
  assert.equal(Passkey.deleteEntitlement('cred3'), true);
  assert.equal(Passkey.getEntitlement('cred3', 's1'), null);
});
