// The guardianship module (FEP-633c) — the multi-party handshake (§3).
// Everyone lives on one in-memory instance here, so the handshake copies all
// converge locally; that also exercises the "multiple local parties" routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');

function site(id, slug) {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run(id, slug, slug, 'u1', id === 's1' ? 1 : 0);
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
}
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
const parent = site('s1', 'parent');   // first guardian-candidate
const kid = site('s2', 'kid');          // ward
const gran = site('s3', 'gran');        // second guardian-candidate (co-approver later)
const A = (slug) => `https://test.example/ap/users/${slug}`;
const [ME, KID, GRAN] = [A('parent'), A('kid'), A('gran')];

// No network: the handshake delivers by feeding each activity straight into the
// inbound handler of every addressed local party (what real S2S would do).
G.wireHandshake({
  selfId: A,
  localSlug: (uri) => (uri.startsWith('https://test.example/ap/users/') ? uri.split('/').pop() : null),
  deriveHandle: (uri) => '@' + uri.split('/').pop() + '@test.example',
  fetchActor: async () => null,
  deliverTo: async (fromSite, toUri, activity) => {
    const slug = toUri.split('/').pop();
    const s = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
    if (s) await G.handleGuardianshipInbox(s, activity);
    return { delivered: true };
  },
  onEvent: null,
});

const offerIdFrom = (r) => r.id;

test('first guardian: a free ward commits on its own single accept', async () => {
  const off = await G.handleGuardianshipOutbox(parent, {
    type: 'Offer', object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: ME },
  });
  assert.equal(off.status, 202);
  const id = offerIdFrom(off);

  // The kid sees the offer needing its accept; the candidate already agreed
  // (the Offer is the candidate's accept), so it just waits.
  const kidQ = G.offersCollection(`${KID}/queues/offers`, 'kid', KID).orderedItems;
  assert.equal(kidQ.length, 1);
  assert.equal(kidQ[0]['shaer:needsMyAccept'], true);
  assert.deepEqual(kidQ[0]['shaer:acceptedBy'], [ME]);       // candidate accepted via the offer
  const parentQ0 = G.offersCollection(`${ME}/queues/offers`, 'parent', ME).orderedItems;
  assert.equal(parentQ0[0]['shaer:needsMyAccept'], false);   // candidate already agreed

  // Not committed until the ward agrees.
  assert.deepEqual(G.listGuardians('kid'), []);

  // The kid accepts → free ward, no existing guardian to co-approve → commit.
  const done = await G.handleGuardianshipOutbox(kid, { type: 'Accept', object: id });
  assert.equal(done.committed, true);
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri), [ME]);
  assert.deepEqual(G.listWards('parent').map((w) => w.other_uri), [KID]);

  // The ward actor now names its guardian; parent reads as guardian (§2).
  assert.deepEqual(AP.buildActor('https://test.example', kid)['shaer:guardians'], [ME]);
  assert.equal(AP.buildActor('https://test.example', parent)['shaer:isGuardian'], true);
  // §1 mutual exclusion: the ward is not also a guardian.
  assert.equal(AP.buildActor('https://test.example', kid)['shaer:isGuardian'], undefined);
});

test('second guardian needs the EXISTING guardian to co-accept (§3.1.2)', async () => {
  // Gran offers to also guard the kid (who already has parent).
  const off = await G.handleGuardianshipOutbox(gran, {
    type: 'Offer', object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: GRAN },
  });
  const id = offerIdFrom(off);
  // The existing guardian (parent) is a party and must accept.
  const parentQ = G.offersCollection(`${ME}/queues/offers`, 'parent', ME).orderedItems.find((o) => o.id === id);
  assert.ok(parentQ, 'parent sees the co-guardianship offer');
  assert.deepEqual(parentQ['shaer:existingGuardians'], [ME]);

  // The kid accepts, but now it IS a ward: NOT committed, because the existing
  // guardian (parent) has not co-accepted (§3.1.2). The candidate (gran) already
  // agreed via the offer, so no separate gran accept is needed.
  const early = await G.handleGuardianshipOutbox(kid, { type: 'Accept', object: id });
  assert.equal(early.committed, false);
  assert.equal(G.listGuardians('kid').length, 1, 'still just the first guardian');

  // The existing guardian co-accepts → tally complete → commit.
  await G.handleGuardianshipOutbox(parent, { type: 'Accept', object: id });
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri).sort(), [GRAN, ME].sort());
});

test('a single Reject from a required party voids the offer (§3.2)', async () => {
  // parent offers to guard gran (who is free).
  const off = await G.handleGuardianshipOutbox(parent, {
    type: 'Offer', object: { type: 'Relationship', subject: GRAN, relationship: 'shaer:Guardian', object: ME },
  });
  const id = offerIdFrom(off);
  await G.handleGuardianshipOutbox(gran, { type: 'Reject', object: id });
  const q = G.offersCollection(`${ME}/queues/offers`, 'parent', ME).orderedItems.find((o) => o.id === id);
  assert.equal(q, undefined, 'voided offer leaves the queue');
  assert.equal(G.listWards('parent').some((w) => w.other_uri === GRAN), false);
});

test('a ward cannot become a guardian (§1)', async () => {
  const r = await G.handleGuardianshipOutbox(kid, {
    type: 'Offer', object: { type: 'Relationship', subject: A('someone'), relationship: 'shaer:Guardian', object: KID },
  });
  assert.equal(r.status, 403);
  assert.equal(r.error, 'a_ward_cannot_guard');
});

test('only the candidate may offer (§3.1 fixed initiator)', async () => {
  const r = await G.handleGuardianshipOutbox(parent, {
    type: 'Offer', object: { type: 'Relationship', subject: A('newkid'), relationship: 'shaer:Guardian', object: GRAN },
  });
  assert.equal(r.status, 403);
  assert.equal(r.error, 'only_the_candidate_offers');
});

test('helpRequest props only ride direct notes', () => {
  assert.equal(G.isHelpRequest({ 'shaer:helpRequest': true }), true);
  assert.equal(G.isHelpRequest({}), false);
});
