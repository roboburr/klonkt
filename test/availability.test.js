// Guardian availability (FEP-633c §3.6): away, dormant, and the lapse.
// These tests mirror the daemon's (routes.rs + availability.rs) one for one,
// same names where possible, so a drift between the two backends shows up as
// a failing test with the same words on both sides (shaer-6d9).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');
const A = G.availability;

const DAY = 24 * 3600 * 1000;
// The handshake and the queue functions read the wall clock (unlike the
// daemon, whose Clock is pinnable), so these tests BACKDATE the evidence
// instead of advancing time: T0 lies eight days in the past, which puts
// "now" at the wall clock for everything that reads it itself.
const T0 = Date.now() - 8 * DAY;
const uri = (slug) => `https://test.example/ap/users/${slug}`;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
function site(id, slug) {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run(id, slug, slug, 'u1', id === 's1' ? 1 : 0);
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
}
// kid3 guarded by g1, g2, g3 (all remote, the ordinary case).
const kid3 = site('s1', 'kid3');
const [G1, G2, G3] = ['https://a.test/u/g1', 'https://b.test/u/g2', 'https://c.test/u/g3'];
for (const g of [G1, G2, G3]) {
  db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, other_handle, status, offer_id)
              VALUES ('kid3','ward',?,?, 'accepted','o1')`).run(g, '@' + g.split('/').pop());
}

// The handshake drives the lapse over the same deps the guardianship tests use.
const delivered = [];
G.wireHandshake({
  selfId: uri,
  localSlug: (u) => (u.startsWith('https://test.example/ap/users/') ? u.split('/').pop() : null),
  deriveHandle: (u) => '@' + u.split('/').pop(),
  fetchActor: async () => null,
  deliverTo: async (fromSite, toUri, activity) => { delivered.push({ toUri, activity }); return { delivered: true }; },
  onEvent: null,
});

/** Three follow decisions address every guardian; g1 and g2 answer, g3 stays
 *  silent; the clock passes the request TTL. */
function makeG3Dormant() {
  db.prepare('DELETE FROM ap_attention_requests').run();
  db.prepare('DELETE FROM ap_guardian_attention').run();
  db.prepare('DELETE FROM ap_lapses').run();
  for (let i = 0; i < 3; i++) {
    for (const g of [G1, G2, G3]) A.recordRequest('kid3', g, `follow-${i}`, T0 + i * 60_000);
  }
  A.oneAnswer(G1, T0 + 3 * 60_000);
  A.oneAnswer(G2, T0 + 3 * 60_000);
  return Date.now();   // the requests are now past the 7-day TTL
}

test('asked nothing never dormant: calendar time alone is no evidence', () => {
  assert.equal(A.observe('kid3', G1, T0 + 1_000_000 * DAY), false);
  assert.equal(A.effective('kid3', G1, T0 + 1_000_000 * DAY), 'active');
});

test('silence on addressed requests makes dormant, and the set shrinks', () => {
  const now = makeG3Dormant();
  const avail = A.availableSet('kid3', [G1, G2, G3], now);
  assert.deepEqual(avail, [G1, G2], 'the set shrank to the two who answered');
  assert.equal(A.effective('kid3', G3, now), 'dormant');
});

test('the dormancy promotion fires the notification duty, once', () => {
  let notices = 0;
  G.wireAvailability({ onDormant: () => { notices++; } });
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  A.availableSet('kid3', [G1, G2, G3], now);
  assert.equal(notices, 1, 'marking dormant MUST notify (3.6.2), on the transition itself');
  G.wireAvailability({});
});

test('one answer restores everything', () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  const ev = A.oneAnswer(G3, now);
  assert.deepEqual(ev.restored, ['kid3']);
  assert.equal(A.effective('kid3', G3, now), 'active');
  assert.equal(A.misses('kid3', G3, now), 0, 'slate clean, no mark');
});

test('away has an end, expires silently, and is never evidence', () => {
  db.prepare('DELETE FROM ap_attention_requests').run();
  db.prepare('DELETE FROM ap_guardian_attention').run();
  A.declareAway('kid3', G2, T0 + 10 * DAY);
  assert.equal(A.effective('kid3', G2, T0 + 5 * DAY), 'away');
  assert.equal(A.awayUntil('kid3', G2, T0 + 5 * DAY), T0 + 10 * DAY);
  // Requests during the absence are not recorded (3.6.1).
  for (let i = 0; i < 5; i++) A.recordRequest('kid3', G2, `req-${i}`, T0 + DAY);
  assert.equal(A.observe('kid3', G2, T0 + 20 * DAY), false);
  assert.equal(A.effective('kid3', G2, T0 + 20 * DAY), 'active', 'the away expired silently, no dormancy left behind');
});

test('declaring away while dormant is an answer', () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  A.declareAway('kid3', G3, now + 3 * DAY);
  assert.equal(A.effective('kid3', G3, now + DAY), 'away');
  assert.equal(A.effective('kid3', G3, now + 3 * DAY), 'active');
});

test('a lapse opens only against a dormant guardian, and never empties', async () => {
  db.prepare('DELETE FROM ap_attention_requests').run();
  db.prepare('DELETE FROM ap_guardian_attention').run();
  // Both active: refused.
  const r = A.openLapse({ id: 'l-x', wardSlug: 'kid3', wardUri: uri('kid3'), target: G3, openedBy: G1, now: T0 });
  assert.equal(r.error, 'not_dormant');
  // A sole guardian can never lapse: that would be emancipation (3.4).
  const solo = site('s2', 'kid1');
  db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('kid1','ward',?, 'accepted','o1')`).run(G1);
  const r2 = A.openLapse({ id: 'l-y', wardSlug: 'kid1', wardUri: uri('kid1'), target: G1, openedBy: G1, now: T0 });
  assert.equal(r2.error, 'would_emancipate');
  assert.ok(solo, 'fixture site exists');
});

test('lapse full flow: release in absentia, over the S2S wire', async () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);   // promote g3

  // The proposing guardian's server delivers an Offer of shaer:Lapse.
  const consumed = await G.handleGuardianshipInbox(kid3, {
    id: 'https://a.test/lapses/1', type: 'Offer', actor: G1, to: [uri('kid3')],
    object: { type: 'shaer:Lapse', 'shaer:ward': uri('kid3'), object: G3 },
  });
  assert.equal(consumed, true);
  const row = A.getLapse('https://a.test/lapses/1');
  assert.ok(row, 'the ward server opened the lapse');
  assert.deepEqual(JSON.parse(row.set_json), [G1, G2], 'the available set, target excluded');
  assert.ok(delivered.some((d) => d.toUri === G3), 'the target is notified in protocol (3.6.2)');

  // The second guardian agrees: 2 of 2, threshold met, but an irreversible
  // decision never settles early (3.5).
  await G.handleGuardianshipInbox(kid3, { type: 'Accept', actor: G2, object: 'https://a.test/lapses/1' });
  assert.equal(A.settleLapse('https://a.test/lapses/1', now + DAY).outcome, 'open', 'the window still runs');
  assert.equal(G.listGuardians('kid3').length, 3);

  // The window closes: released in absentia. The lapse opened at the wall
  // clock (inside the handshake), so the margin of a day absorbs the skew.
  const after = Date.now() + A.LAPSE_WINDOW_MS + DAY;
  const settled = A.settleLapse('https://a.test/lapses/1', after);
  assert.equal(settled.outcome, 'completed');
  assert.equal(settled.applied, true);
  assert.deepEqual(G.listGuardians('kid3').map((g) => g.other_uri), [G1, G2]);
  // Settling twice never applies twice.
  assert.equal(A.settleLapse('https://a.test/lapses/1', after).applied, true);
  assert.equal(G.listGuardians('kid3').length, 2);

  // Restore the fixture for the remaining tests.
  db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('kid3','ward',?, 'accepted','o1')`).run(G3);
});

test('one answer cancels a running lapse and restores the target', async () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  await G.handleGuardianshipInbox(kid3, {
    id: 'https://a.test/lapses/2', type: 'Offer', actor: G1, to: [uri('kid3')],
    object: { type: 'shaer:Lapse', 'shaer:ward': uri('kid3'), object: G3 },
  });
  // The target shows a sign of life: anything at all.
  const ev = A.oneAnswer(G3, now + DAY);
  assert.equal(ev.cancelledLapses.length, 1);
  assert.equal(A.lapseOutcome(A.getLapse('https://a.test/lapses/2'), now + A.LAPSE_WINDOW_MS + DAY), 'cancelled');
  assert.equal(A.settleLapse('https://a.test/lapses/2', now + A.LAPSE_WINDOW_MS + DAY).applied, false);
  assert.equal(G.listGuardians('kid3').length, 3, 'one answer cancelled the lapse');
  assert.equal(A.effective('kid3', G3, now + DAY), 'active', 'and restored the guardian');
});

test('a stranger cannot make up the majority', async () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  await G.handleGuardianshipInbox(kid3, {
    id: 'https://a.test/lapses/3', type: 'Offer', actor: G1, to: [uri('kid3')],
    object: { type: 'shaer:Lapse', 'shaer:ward': uri('kid3'), object: G3 },
  });
  const r = A.lapseVote('https://a.test/lapses/3', 'https://evil.test/u/stranger', true, now);
  assert.equal(r.error, 'not_in_set');
  const t = A.lapseVote('https://a.test/lapses/3', G3, true, now);
  assert.equal(t.error, 'not_in_set', 'the target is not in the set either');
});

test('the offers queue carries the lapse, the same shape the daemon serves', async () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  await G.handleGuardianshipInbox(kid3, {
    id: 'https://a.test/lapses/4', type: 'Offer', actor: G1, to: [uri('kid3')],
    object: { type: 'shaer:Lapse', 'shaer:ward': uri('kid3'), object: G3 },
  });
  const col = G.offersCollection(`${uri('kid3')}/queues/offers`, 'kid3', uri('kid3'));
  const item = col.orderedItems.find((i) => i.id === 'https://a.test/lapses/4');
  assert.ok(item, 'the ward sees the running lapse');
  assert.equal(item.object.type, 'shaer:Lapse');
  assert.equal(item['shaer:threshold'], 2);
  assert.equal(item['shaer:outcome'], 'open');
});

test('the guardians queue serves availability, never the public actor doc', () => {
  const now = makeG3Dormant();
  A.availableSet('kid3', [G1, G2, G3], now);
  A.declareAway('kid3', G2, now + 5 * DAY);
  const col = G.guardiansCollection(`${uri('kid3')}/queues/guardians`, 'kid3');
  const by = Object.fromEntries(col.orderedItems.map((i) => [i.id, i]));
  assert.equal(by[G1]['shaer:availability'], 'active');
  assert.equal(by[G2]['shaer:availability'], 'away');
  assert.equal(by[G3]['shaer:availability'], 'dormant');
  // The PUBLIC actor document says nothing about any of this (3.6.1).
  const doc = AP.buildActor('https://test.example', kid3);
  assert.ok(!JSON.stringify(doc).match(/away|dormant|availability/i), 'availability is timing intelligence and stays out of the public doc');
});

test('the away note emits shaer:away with a plain AS2 endTime', () => {
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, visibility, to_actors, away_until, created_at)
    VALUES ('aw1','kid3','',NULL,NULL,'https://b.test/u/g2','@g2','<p>weg</p>','direct','["https://b.test/u/g2"]',?,CURRENT_TIMESTAMP)`).run(T0 + 10 * DAY);
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get('aw1');
  const note = AP.buildReplyNote('https://test.example', kid3, row);
  assert.equal(note['shaer:away'], true);
  assert.equal(note.endTime, new Date(T0 + 10 * DAY).toISOString());
  assert.equal(A.parseEndTime(note.endTime), T0 + 10 * DAY, 'and it round-trips through the parser');
});

test('the gated tally runs over the available set (§3.5)', () => {
  // The arithmetic problem this section exists for: five guardians of whom
  // two are gone. Over the full set the threshold is 3 and the two absentees
  // block every decision by silence alone; over the available set (3) the
  // threshold is 2 and the living can still decide.
  site('s3', 'kid5');
  const gs = [1, 2, 3, 4, 5].map((n) => `https://g${n}.test/u/g`);
  for (const g of gs) {
    db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, status, offer_id) VALUES ('kid5','ward',?, 'accepted','o1')`).run(g);
  }
  for (let i = 0; i < 3; i++) for (const g of [gs[3], gs[4]]) A.recordRequest('kid5', g, `req-${i}`, T0);
  const now = T0 + 8 * DAY;
  assert.deepEqual(A.availableSet('kid5', gs, now), gs.slice(0, 3));

  const r1 = G.gated.recordGatedVote('kid5', 'shaer:externalEmbeds', gs[0], true);
  assert.equal(r1.state, 'open');
  assert.equal(r1.need, 2, 'threshold over the available set of 3, not 3 of 5');
  const r2 = G.gated.recordGatedVote('kid5', 'shaer:externalEmbeds', gs[1], true);
  assert.equal(r2.state, 'settled');
  assert.equal(r2.value, true, 'two living guardians decide; the absent no longer freeze the ward');
});
