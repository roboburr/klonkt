// FEP-633c §5.3: follow-gating store. A follow on a ward waits for guardians.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const G = await import('../src/services/guardianship/index.js');

const A = (s) => `https://test.example/ap/users/${s}`;
const [KID, MOM, DAD, STRANGER] = [A('kid'), A('mom'), A('dad'), A('stranger')];

test('any-quorum: one guardian approval is enough', () => {
  G.follows.recordPending('kid', { id: 'f1', follower: STRANGER, inbox: `${STRANGER}/inbox`, quorum: 'any' });
  assert.equal(G.follows.listForWard('kid').length, 1);
  const r = G.follows.decide('f1', MOM, 'approve', [MOM, DAD]);
  assert.equal(r.outcome, 'approved');
  G.follows.remove('f1');
  assert.equal(G.follows.listForWard('kid').length, 0);
});

test('all-quorum: needs every guardian', () => {
  G.follows.recordPending('kid', { id: 'f2', follower: STRANGER, inbox: `${STRANGER}/inbox`, quorum: 'all' });
  assert.equal(G.follows.decide('f2', MOM, 'approve', [MOM, DAD]).outcome, 'waiting');
  assert.equal(G.follows.decide('f2', DAD, 'approve', [MOM, DAD]).outcome, 'approved');
});

test('a single reject denies the follow (§3.2 spirit)', () => {
  G.follows.recordPending('kid', { id: 'f3', follower: STRANGER, inbox: `${STRANGER}/inbox`, quorum: 'any' });
  const r = G.follows.decide('f3', DAD, 'reject', [MOM, DAD]);
  assert.equal(r.outcome, 'rejected');
});

test('guardian-side review copy (cross-instance, modelled on the offer)', () => {
  // A remote ward's server forwarded an Offer(Follow); the guardian stores a copy.
  G.follows.recordReview('gran', { id: 'r1', wardUri: 'https://w.example/kid', wardInbox: 'https://w.example/kid/inbox', follower: STRANGER, followerHandle: '@x@m.social' });
  const list = G.follows.listReviews('gran');
  assert.equal(list.length, 1);
  assert.equal(list[0].ward_inbox, 'https://w.example/kid/inbox');
  assert.ok(G.follows.getReview('gran', 'r1'));
  G.follows.removeReview('gran', 'r1');
  assert.equal(G.follows.listReviews('gran').length, 0);
});
