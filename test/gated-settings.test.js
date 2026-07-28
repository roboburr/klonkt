// FEP-633c §5.6 + §3.5: a gated setting is decided by the guardians together,
// by threshold within a window, and it has to work across servers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { tallyGatedSetting, thresholdFor, featureColumn } = await import('../src/services/guardianship/gated.js');

const G3 = ['https://a/g1', 'https://b/g2', 'https://c/g3'];   // three, on three servers
const vote = (uri, value) => ({ guardian_uri: uri, value });

test('the threshold is a strict majority', () => {
  assert.equal(thresholdFor(1), 1);
  assert.equal(thresholdFor(2), 2);
  assert.equal(thresholdFor(3), 2);
  assert.equal(thresholdFor(4), 3);
});

test('it settles the moment the majority is there, without waiting for the rest', () => {
  const r = tallyGatedSetting([vote(G3[0], true), vote(G3[1], true)], G3, 1000);
  assert.deepEqual(r, { state: 'settled', value: true });
});

test('one guardian alone does not decide for the others', () => {
  const r = tallyGatedSetting([vote(G3[0], true)], G3, 1000);
  assert.equal(r.state, 'open', 'a single voice is not the guardians as a group');
});

test('it also settles early when the majority has become unreachable', () => {
  const r = tallyGatedSetting([vote(G3[0], false), vote(G3[1], false)], G3, 1000);
  assert.deepEqual(r, { state: 'settled', value: false }, 'two against is itself a majority');
});

test('an undecided decision fails closed at the deadline', () => {
  const open = tallyGatedSetting([vote(G3[0], true)], G3, 1000);
  assert.equal(open.state, 'open');
  const late = tallyGatedSetting([vote(G3[0], true)], G3, 25 * 60 * 60 * 1000);
  assert.equal(late.state, 'expired', 'silence is an answer once the window closes');
});

test('answers from outside the snapshotted set are ignored', () => {
  const r = tallyGatedSetting([vote(G3[0], true), vote('https://x/stranger', true)], G3, 1000);
  assert.equal(r.state, 'open', 'a stranger cannot make up the majority');
});

test('a ward with no guardians has nobody to decide, so nothing is granted', () => {
  assert.equal(tallyGatedSetting([vote('https://a/g1', true)], [], 1000).state, 'expired');
});

test('a guardian changing its mind replaces its own answer, it does not add one', () => {
  // The store keys on (slug, feature, guardian), so the tally sees one per guardian.
  const r = tallyGatedSetting([vote(G3[0], true), vote(G3[0], false), vote(G3[1], false)], G3, 1000);
  assert.deepEqual(r, { state: 'settled', value: false });
});

test('unknown features are refused, never guessed onto a column', () => {
  assert.equal(featureColumn('shaer:externalEmbeds'), 'external_embeds');
  assert.equal(featureColumn('shaer:somethingElse'), null);
  assert.equal(featureColumn('external_embeds = 1; DROP TABLE sites'), null);
});

// Guard against the mistake that made the button do nothing: the route called
// AP.deliverTo, which existed only as a key in the guardianship deps object and
// not as an export. It threw a TypeError, Express answered 500, and the button
// silently reset. A grep hit is not an export.
test('the guardian route can reach every ActivityPub helper it calls', async () => {
  const AP = (await import('../src/services/ActivityPubService.js')).default;
  for (const fn of ['actorId', 'deliverToActor', 'followActor', 'backfillFromOutbox', 'getTimeline']) {
    assert.equal(typeof AP[fn], 'function', `AP.${fn} must be exported, the guardian route calls it`);
  }
});

test('a gated-setting Offer carries ward, feature and value', async () => {
  const { buildGatedOffer, parseGatedSetting } = await import('../src/services/guardianship/gated.js');
  const o = buildGatedOffer('https://a/gated/1', 'https://a/g1', 'https://b/ward', 'shaer:externalEmbeds', true);
  assert.equal(o.type, 'Offer');
  assert.deepEqual(o.to, ['https://b/ward'], 'addressed to the ward server, which tallies');
  const parsed = parseGatedSetting(o.object);
  assert.deepEqual(parsed, { ward: 'https://b/ward', feature: 'shaer:externalEmbeds', value: true });
  assert.equal(parseGatedSetting({ type: 'Relationship' }), null, 'a different Offer is not ours');
});
