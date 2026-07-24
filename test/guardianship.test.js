// The guardianship module (FEP-633c): relations, actor props, the adoption
// handshake and the dashboard queues. Pins the module's public surface so the
// Shaer clients' contract stays stable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'parent', 'Parent', 'u1', 1);
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s2', 'kid', 'Kid', 'u1', 0);
const parent = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const kid = db.prepare('SELECT * FROM sites WHERE id = ?').get('s2');
const ME = 'https://test.example/ap/users/parent';
const KID = 'https://test.example/ap/users/kid';

// No network in tests: the handshake delivers via this stub.
const sent = [];
G.wireHandshake({
  selfId: (slug) => `https://test.example/ap/users/${slug}`,
  deliverTo: async (site, uri, activity) => { sent.push({ from: site.slug, to: uri, activity }); return true; },
  deriveHandle: (uri) => '@' + String(uri).split('/').pop() + '@test.example',
  onEvent: null,
});

test('actor doc advertises shaer:queues (and blocked stays)', () => {
  const actor = AP.buildActor('https://test.example', parent);
  assert.equal(actor.blocked, `${ME}/blocked`);
  assert.deepEqual(actor['shaer:queues'], {
    offers: `${ME}/queues/offers`,
    follows: `${ME}/queues/follows`,
    wards: `${ME}/queues/wards`,
  });
  assert.equal(actor['shaer:isGuardian'], undefined);   // no wards yet
});

test('C2S Offer from the candidate records + delivers (FEP-633c 3)', async () => {
  const r = await G.handleGuardianshipOutbox(parent, {
    type: 'Offer',
    object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: ME },
  });
  assert.equal(r.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, KID);
  assert.equal(sent[0].activity.type, 'Offer');
  const wards = G.listWards('parent');
  assert.equal(wards.length, 1);
  assert.equal(wards[0].status, 'offered');
  // The guardian-to-be now reads as guardian; the actor doc follows.
  const actor = AP.buildActor('https://test.example', parent);
  assert.equal(actor['shaer:isGuardian'], true);
});

test('only the candidate may offer', async () => {
  const r = await G.handleGuardianshipOutbox(parent, {
    type: 'Offer',
    object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: 'https://elders.test/u/x' },
  });
  assert.equal(r.status, 403);
});

test('inbound Offer parks in the ward queue; C2S Accept commits both ends', async () => {
  // The kid's side receives the offer S2S.
  const offerId = sent[0].activity.id;
  const consumed = await G.handleGuardianshipInbox(kid, {
    id: offerId, type: 'Offer', actor: ME,
    object: { type: 'Relationship', subject: KID, relationship: 'shaer:Guardian', object: ME },
  });
  assert.equal(consumed, true);
  assert.equal(G.listOffers('kid').length, 1);

  // The kid accepts over C2S; the answer travels to the guardian.
  const r = await G.handleGuardianshipOutbox(kid, { type: 'Accept', object: offerId });
  assert.equal(r.status, 202);
  assert.deepEqual(G.listGuardians('kid').map((g) => g.other_uri), [ME]);

  // The guardian's side hears the Accept S2S and commits.
  const ok = await G.handleGuardianshipInbox(parent, { type: 'Accept', actor: KID, object: offerId });
  assert.equal(ok, true);
  const wards = G.listWards('parent').filter((w) => w.status === 'accepted');
  assert.deepEqual(wards.map((w) => w.other_uri), [KID]);

  // The ward's actor doc now names its guardian (FEP-633c 2.1).
  const actor = AP.buildActor('https://test.example', kid);
  assert.deepEqual(actor['shaer:guardians'], [ME]);
});

test('queues serve the daemon contract shapes', () => {
  const wardsQ = G.wardsCollection(`${ME}/queues/wards`, 'parent');
  assert.equal(wardsQ.type, 'OrderedCollection');
  assert.equal(wardsQ.totalItems, 1);
  assert.equal(wardsQ.orderedItems[0].id, KID);
  const followsQ = G.followsCollection(`${ME}/queues/follows`);
  assert.deepEqual(followsQ.orderedItems, []);
  const offersQ = G.offersCollection(`${ME}/queues/offers`, 'parent', ME);
  assert.equal(offersQ.type, 'OrderedCollection');   // empty again after the accept
  assert.equal(offersQ.totalItems, 0);
});

test('a ward cannot become a guardian (FEP-633c 1)', async () => {
  const r = await G.handleGuardianshipOutbox(kid, {
    type: 'Offer',
    object: { type: 'Relationship', subject: 'https://other.test/u/y', relationship: 'shaer:Guardian', object: KID },
  });
  assert.equal(r.status, 403);
  assert.equal(r.error, 'a_ward_cannot_guard');
});

test('helpRequest props only ride direct notes', () => {
  assert.deepEqual(G.helpRequestProps({ visibility: 'direct', help_request: 1 }), { 'shaer:helpRequest': true });
  assert.deepEqual(G.helpRequestProps({ visibility: 'public', help_request: 1 }), {});
  assert.equal(G.isHelpRequest({ 'shaer:helpRequest': true }), true);
  assert.equal(G.isHelpRequest({}), false);
});
