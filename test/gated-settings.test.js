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

// The leg that was missing, found on the live fleet: a proposal addressed to
// the ward's server reached only the proposer and the ward. The two guardians
// on other servers never learned it existed, so the threshold of two could
// never be met and every proposal expired unanswered. Link previews for beta
// stayed off not because anyone objected, but because nobody could answer.
test('the ward forwards a proposal to the other guardians, or nobody can answer', async () => {
  const dbMod2 = await import('../src/config/database.js');
  const database = dbMod2.default;
  const G = await import('../src/services/guardianship/index.js');
  const WARD = 'https://test.example/ap/users/kid9';
  const [A, B, C] = ['https://a.test/u/a', 'https://b.test/u/b', 'https://c.test/u/c'];
  database.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u9', 'u9', 'u9@t', 'x', 'god');
  database.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)').run('s9', 'kid9', 'kid9', 'u9');
  for (const g of [A, B, C]) {
    database.prepare("INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('kid9','ward',?, 'accepted','o')").run(g);
  }
  const sent = [];
  G.wireHandshake({
    selfId: (slug) => `https://test.example/ap/users/${slug}`,
    localSlug: (u) => (u.startsWith('https://test.example/ap/users/') ? u.split('/').pop() : null),
    deriveHandle: (u) => '@' + u.split('/').pop(),
    fetchActor: async (u) => ({ id: u, inbox: `${u}/inbox` }),
    deliverTo: async (s, to, act) => { sent.push({ to, act }); return { delivered: true }; },
    onEvent: null,
  });
  const site = database.prepare('SELECT * FROM sites WHERE slug = ?').get('kid9');

  // A proposes. The ward records A's own vote (1 of 3, threshold 2: open).
  const offer = G.gated.buildGatedOffer('https://a.test/gated/1', A, WARD, 'shaer:externalEmbeds', true);
  assert.equal(await G.handleGuardianshipInbox(site, { ...offer, actor: A }), true);
  assert.equal(database.prepare('SELECT external_embeds FROM sites WHERE slug = ?').get('kid9').external_embeds, null, 'one voice is not a majority');

  // The forward: B and C are told, A is not asked twice.
  const told = sent.filter((x) => x.act.object && x.act.object['shaer:feature']).map((x) => x.to).sort();
  assert.deepEqual(told, [B, C].sort(), 'both other guardians must receive the proposal');

  // B receives its copy on its own server and can answer it.
  database.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)').run('s10', 'gb', 'gb', 'u9');
  database.prepare("INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('gb','guardian',?, 'accepted','o')").run(WARD);
  const gbSite = database.prepare('SELECT * FROM sites WHERE slug = ?').get('gb');
  assert.equal(await G.handleGuardianshipInbox(gbSite, { ...offer, actor: A, to: ['https://test.example/ap/users/gb'] }), true);
  const review = G.gated.listGatedReviews('gb')[0];
  assert.ok(review, 'the guardian stores a copy it can answer');
  assert.equal(review.feature, 'shaer:externalEmbeds');
  assert.equal(review.ward_uri, WARD);

  // B's Accept reaches the ward: 2 of 3, the threshold, and the gate opens.
  assert.equal(await G.handleGuardianshipInbox(site, { type: 'Accept', actor: B, object: 'https://a.test/gated/1' }), true);
  assert.equal(database.prepare('SELECT external_embeds FROM sites WHERE slug = ?').get('kid9').external_embeds, 1,
    'two of three agreed, so the ward may see link previews');
});
