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
  // other_handle is the display @handle (not the escalation inbox handle).
  assert.equal(G.listGuardians('kid')[0].other_handle, '@parent@test.example');
  assert.equal(G.listWards('parent')[0].other_handle, '@kid@test.example');

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

test('a candidate adopted between Offer and Accept is refused at commit (§4.2)', async () => {
  // The case the §1 check above structurally cannot catch. Tess is free when
  // she offers, so the Offer is legitimate and accepted. Only afterwards does
  // she become a ward herself. An implementation that checks the candidate
  // only when the Offer arrives would commit her anyway, and Sam would be left
  // counting a guardian whose escalations get dropped (§4.1).
  // Fresh actors throughout: the suite shares one database, so adopting Tess
  // with an existing guardian would hand that guardian an extra ward and
  // quietly change the arithmetic of the emancipation tests further down.
  const tess = site('s10', 'tess');
  const sam = site('s11', 'sam');
  const ada = site('s12', 'ada');
  const [TESS, SAM, ADA] = [A('tess'), A('sam'), A('ada')];

  // 1. Tess offers to guard Sam while she is still free of guardians.
  const off = await G.handleGuardianshipOutbox(tess, {
    type: 'Offer', object: { type: 'Relationship', subject: SAM, relationship: 'shaer:Guardian', object: TESS },
  });
  assert.equal(off.status, 202, 'a free candidate may offer');
  const id = off.id;
  assert.deepEqual(G.listGuardians('sam'), [], 'nothing committed until Sam accepts');

  // 2. Before Sam answers, Tess is adopted: she is now a ward herself.
  const adopt = await G.handleGuardianshipOutbox(ada, {
    type: 'Offer', object: { type: 'Relationship', subject: TESS, relationship: 'shaer:Guardian', object: ADA },
  });
  await G.handleGuardianshipOutbox(tess, { type: 'Accept', object: adopt.id });
  assert.equal(G.listGuardians('tess').length, 1, 'Tess is a ward now');

  // 3. Sam accepts. The tally is complete, so this WOULD commit.
  const done = await G.handleGuardianshipOutbox(sam, { type: 'Accept', object: id });
  assert.equal(done.committed, false, 'but a ward cannot serve as a guardian (§1)');
  assert.equal(done.refused, 'not_a_teapot');

  // The refusal is loud, not a silent skip: nothing recorded, offer voided.
  assert.deepEqual(G.listGuardians('sam'), [], 'Sam gains no guardian');
  assert.deepEqual(G.listWards('tess').map((w) => w.other_uri), [], 'and Tess gains no ward');
  const stillPending = G.offersCollection(`${SAM}/queues/offers`, 'sam', SAM).orderedItems.filter((o) => o.id === id);
  assert.deepEqual(stillPending, [], 'the handshake is void, not left hanging');
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

// ── §3.2/§3.3: ending a guardianship ─────────────────────────────────────
// This used to be a local delete that never left the building: the guardian's
// dashboard forgot the ward, while the ward's server kept listing them in
// shaer:guardians. Robin calls that a bug, and it is: the Undo has to travel.
// At this point in the file the kid has two guardians, parent and gran.

test('a guardian leaving sends an Undo that both sides act on (§3.2)', async () => {
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri).sort(), [ME, GRAN].sort(), 'two guardians to start');

  const r = await G.endGuardianship(gran, KID);
  assert.equal(r.status, 202);
  assert.equal(r.delivered, true, 'the Undo went out, it is not a local delete');

  // The ward's own actor document is the thing that had to change.
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri), [ME]);
  assert.deepEqual(AP.buildActor('https://test.example', kid)['shaer:guardians'], [ME]);
  assert.deepEqual(G.listWards('gran'), [], 'and the leaving guardian lost the ward');
  assert.deepEqual(G.listWards('parent').map((w) => w.other_uri), [KID], 'the other guardian stays');
});

test('the last guardian cannot walk out alone: that is emancipation (§3.4)', async () => {
  const r = await G.endGuardianship(parent, KID);
  assert.equal(r.status, 409);
  assert.equal(r.error, 'would_emancipate');
  // Nothing moved on either side. Emptying shaer:guardians takes the flow of
  // §3.4 (three consenting adults, or a majority plus two witnesses), never one
  // party's click.
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri), [ME]);
  assert.deepEqual(G.listWards('parent').map((w) => w.other_uri), [KID]);
});

test('an Undo for a ward that is not yours is refused', async () => {
  const r = await G.endGuardianship(gran, KID);   // gran already left
  assert.equal(r.status, 404);
  assert.equal(r.error, 'not_my_ward');
});

test('the same Undo over C2S takes the same path', async () => {
  // A Guardian app POSTs this to its own outbox; the dashboard button calls
  // endGuardianship directly. One path, so the two cannot drift apart.
  const undo = { type: 'Undo', object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: GRAN } };
  const mine = await G.handleGuardianshipOutbox(gran, undo);
  assert.equal(mine.status, 404, 'gran no longer guards the kid');

  // And you cannot end someone else's relation by describing it.
  const notMine = await G.handleGuardianshipOutbox(parent, undo);
  assert.equal(notMine.status, 403);
  assert.equal(notMine.error, 'not_your_relation');
});

test('an inbound Undo from someone who is not the guardian changes nothing', async () => {
  const before = G.listGuardians('kid').map((g) => g.other_uri);
  await G.handleGuardianshipInbox(kid, {
    actor: GRAN,   // gran claims to end PARENT's relation
    type: 'Undo', object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: ME },
  });
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri), before);
});

test('a ward on this same instance is updated even though nothing is delivered', async () => {
  // The browser found this: an inbox on this machine is not reachable over HTTP
  // from this machine (nor should it be), so a co-located ward never receives
  // the Undo. The guardian's side had dropped the ward while the ward's side
  // still listed the guardian. Each instance must write what it hosts.
  const kid2 = site('s4', 'kid2');
  const g1 = site('s5', 'g1');
  const g2 = site('s6', 'g2');
  const [KID2, G1, G2] = [A('kid2'), A('g1'), A('g2')];

  const o1 = await G.handleGuardianshipOutbox(g1, {
    type: 'Offer', object: { type: 'Relationship', subject: KID2, relationship: 'shaer:Guardian', object: G1 } });
  await G.handleGuardianshipOutbox(kid2, { type: 'Accept', object: o1.id });
  const o2 = await G.handleGuardianshipOutbox(g2, {
    type: 'Offer', object: { type: 'Relationship', subject: KID2, relationship: 'shaer:Guardian', object: G2 } });
  await G.handleGuardianshipOutbox(kid2, { type: 'Accept', object: o2.id });
  await G.handleGuardianshipOutbox(g1, { type: 'Accept', object: o2.id });
  assert.deepEqual(G.listGuardians('kid2').map((g) => g.other_uri).sort(), [G1, G2].sort());

  // Now deliver nothing at all, the way a loopback inbox behaves in practice.
  const wired = {
    selfId: A,
    localSlug: (uri) => (uri.startsWith('https://test.example/ap/users/') ? uri.split('/').pop() : null),
    deriveHandle: (uri) => '@' + uri.split('/').pop() + '@test.example',
    fetchActor: async () => null,
    deliverTo: async () => ({ delivered: false }),
    onEvent: null,
  };
  G.wireHandshake(wired);
  const r = await G.endGuardianship(g2, KID2);
  assert.equal(r.status, 202);
  assert.equal(r.delivered, false, 'nothing went over the wire');
  assert.deepEqual(G.listWards('g2'), [], "the guardian's side is clear");
  assert.deepEqual(G.listGuardians('kid2').map((g) => g.other_uri), [G1], "and so is the ward's");
  assert.deepEqual(AP.buildActor('https://test.example', kid2)['shaer:guardians'], [G1]);

  // Even undelivered, it must not empty the set: that is still emancipation.
  const last = await G.endGuardianship(g1, KID2);
  assert.equal(last.status, 409);
  assert.deepEqual(G.listGuardians('kid2').map((g) => g.other_uri), [G1]);
});
