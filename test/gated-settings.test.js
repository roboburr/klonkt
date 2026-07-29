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
  const fwd = sent.filter((x) => x.act.object && x.act.object['shaer:feature']);
  assert.deepEqual(fwd.map((x) => x.to).sort(), [B, C].sort(), 'both other guardians must receive the proposal');
  // And it must go out AS THE WARD, because the ward's key signs it. Sending
  // it with the proposer still in `actor` is a signer mismatch: every receiver
  // answers 401 and the proposal silently never arrives. Live proof, from
  // beta's log: "guardianship Offer got 401 from boiert.eu/.../inbox". The
  // first version of this test checked THAT a forward happened and not on
  // whose behalf, so it passed while nothing worked.
  for (const x of fwd) {
    assert.equal(x.act.actor, WARD, 'the forward is signed by the ward, so it must say the ward');
    assert.equal(x.act['shaer:proposer'], A, 'and it carries who actually proposed it');
  }

  // B receives its copy on its own server and can answer it.
  database.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)').run('s10', 'gb', 'gb', 'u9');
  database.prepare("INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('gb','guardian',?, 'accepted','o')").run(WARD);
  const gbSite = database.prepare('SELECT * FROM sites WHERE slug = ?').get('gb');
  // Exactly the shape the ward sends: actor = the ward, proposer alongside.
  assert.equal(await G.handleGuardianshipInbox(gbSite, {
    ...offer, actor: WARD, 'shaer:proposer': A, to: ['https://test.example/ap/users/gb'],
  }), true);
  const review = G.gated.listGatedReviews('gb')[0];
  assert.ok(review, 'the guardian stores a copy it can answer');
  assert.equal(review.proposer, A, 'the screen names who proposed it, not the ward that relayed it');
  assert.equal(review.feature, 'shaer:externalEmbeds');
  assert.equal(review.ward_uri, WARD);

  // B's Accept reaches the ward: 2 of 3, the threshold, and the gate opens.
  assert.equal(await G.handleGuardianshipInbox(site, { type: 'Accept', actor: B, object: 'https://a.test/gated/1' }), true);
  assert.equal(database.prepare('SELECT external_embeds FROM sites WHERE slug = ?').get('kid9').external_embeds, 1,
    'two of three agreed, so the ward may see link previews');

  // And the loop CLOSES: the ward's server answers the Offer that opened the
  // decision, back to the proposer. Without this the proposer's screen can
  // only ever say "waiting", forever, whatever actually happened: the tally is
  // the ward server's private ledger and nobody else may read it.
  const answer = sent.find((x) => x.to === A && (x.act.type === 'Accept' || x.act.type === 'Reject'));
  assert.ok(answer, 'the proposer is told the outcome');
  assert.equal(answer.act.type, 'Accept', 'it settled on what A proposed');
  assert.equal(answer.act.actor, WARD, 'and only the ward may say so');
  assert.equal(answer.act.object, 'https://a.test/gated/1', 'referencing the offer it answers');
});

test("the proposer's own book: sent, answered, or honestly expired", async () => {
  const dbMod3 = await import('../src/config/database.js');
  const database = dbMod3.default;
  const G = await import('../src/services/guardianship/index.js');
  const WARD = 'https://kids.example/ap/users/maan';
  const ME = 'https://test.example/ap/users/oma1';
  database.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u11', 'u11', 'u11@t', 'x', 'god');
  database.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)').run('s11', 'oma1', 'oma1', 'u11');
  database.prepare("INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('oma1','guardian',?, 'accepted','o')").run(WARD);
  const site = database.prepare('SELECT * FROM sites WHERE slug = ?').get('oma1');

  // The route records what it sent; here we do what the route does.
  G.gated.recordSent(`${ME}/gated/p1`, 'oma1', WARD, 'shaer:externalPlayback', true);
  assert.equal(G.gated.sentStatus(G.gated.recallSent(`${ME}/gated/p1`), Date.now()), 'open');

  // A stranger claiming an outcome is not one: only the ward's voice counts.
  assert.equal(await G.handleGuardianshipInbox(site, { type: 'Accept', actor: 'https://evil.test/u/x', object: `${ME}/gated/p1` }), false);
  assert.equal(G.gated.recallSent(`${ME}/gated/p1`).status, 'open', 'still open: a stranger cannot close our books');

  // The ward's server answers: the row settles.
  assert.equal(await G.handleGuardianshipInbox(site, { type: 'Accept', actor: WARD, object: `${ME}/gated/p1` }), true);
  assert.equal(G.gated.recallSent(`${ME}/gated/p1`).status, 'accepted');
  assert.equal(G.gated.sentStatus(G.gated.recallSent(`${ME}/gated/p1`), Date.now()), 'accepted');

  // A Reject is an answer too, and lands as one.
  G.gated.recordSent(`${ME}/gated/p2`, 'oma1', WARD, 'shaer:externalEmbeds', false);
  assert.equal(await G.handleGuardianshipInbox(site, { type: 'Reject', actor: WARD, object: `${ME}/gated/p2` }), true);
  assert.equal(G.gated.sentStatus(G.gated.recallSent(`${ME}/gated/p2`), Date.now()), 'rejected');

  // Silence past the window is not "still running": it is over, and the
  // screen must say so instead of promising forever.
  G.gated.recordSent(`${ME}/gated/p3`, 'oma1', WARD, 'shaer:externalEmbeds', true);
  const row = G.gated.recallSent(`${ME}/gated/p3`);
  assert.equal(G.gated.sentStatus(row, Date.now()), 'open');
  assert.equal(G.gated.sentStatus(row, Date.now() + 25 * 60 * 60 * 1000), 'expired');
});

// Playback is the heavier sibling of the preview (5.6): seeing that a video
// exists is one decision, letting a third party's player run inside the app is
// another. The hole this closes: the web Krant built the YouTube iframe from
// the note's content on a path that never touched the gate, so a ward whose
// guardians had allowed nothing still got the full player, while the app
// showed nothing at all. The heavy thing open, the light thing shut.
test('a player URL rides only when the playback gate is open', async () => {
  const AP2 = (await import('../src/services/ActivityPubService.js')).default;
  const yt = JSON.stringify({ url: 'https://www.youtube.com/watch?v=HetoL4XpHwY', title: 'x', media: [] });

  const shut = AP2.timelineEmbed(yt);
  assert.ok(shut && shut.url, 'the card itself still travels');
  assert.equal(shut['shaer:playerUrl'], undefined, 'no player without the gate');
  // But the card says there IS something behind the gate, so the app can
  // explain the silence instead of ignoring a tap. Robin tapped a video that
  // could not answer and nothing happened, which reads as broken, not as shut.
  assert.equal(shut['shaer:playable'], true, 'a shut gate still admits that a player exists');

  const open = AP2.timelineEmbed(yt, { playback: true });
  assert.match(open['shaer:playerUrl'], /^https:\/\/www\.youtube-nocookie\.com\/embed\/HetoL4XpHwY/,
    'privacy-enhanced only: nocookie, no related videos');
  assert.match(open['shaer:playerUrl'], /rel=0/);
});

test('a page we will not frame simply stays a thumbnail', async () => {
  const AP2 = (await import('../src/services/ActivityPubService.js')).default;
  const page = JSON.stringify({ url: 'https://yougubrands.com/about', title: 'About', media: [] });
  assert.equal(AP2.timelineEmbed(page, { playback: true })['shaer:playerUrl'], undefined);
  // And no promise of one either: a news article is not a shut gate, it is
  // simply not a video, and the app must not offer to ask for it.
  assert.equal(AP2.timelineEmbed(page)['shaer:playable'], undefined);
  assert.equal(AP2.playerUrlFor('https://nos.nl/artikel/1'), null);
  // PeerTube is decentralised, so it is matched by shape, not by a host list.
  assert.equal(AP2.playerUrlFor('https://tilvids.com/w/abc123def'), 'https://tilvids.com/videos/embed/abc123def');
});

test('playback needs the preview gate: you cannot play what you may not see', async () => {
  const G2 = await import('../src/services/guardianship/index.js');
  // Both auto (a ward): both shut.
  assert.equal(G2.externalEmbedsAllowed(null, true), false);
  assert.equal(G2.externalPlaybackAllowed(null, true), false);
  // Guardians opened previews only: playback stays a separate decision.
  assert.equal(G2.externalEmbedsAllowed(1, true), true);
  assert.equal(G2.externalPlaybackAllowed(null, true), false);
  // An adult account has nothing gated.
  assert.equal(G2.externalPlaybackAllowed(null, false), true);
});
