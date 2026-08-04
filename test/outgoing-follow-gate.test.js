// FEP-633c §5.3, the direction that was never gated (bead shaer-p729).
//
// A ward's own follow used to go straight out; the guardians got a note
// afterwards, which is informing, not gating — the door is already open by the
// time the message lands. Now it waits, with two exceptions that are not
// favours but the same decision already taken: the ward's own guardian, and
// someone a guardian already admitted through the inbound gate.
//
// The mutual shortcut only counts followers who came through that gate. A
// follower a free actor collected before it was ever a ward was never seen by
// a guardian, so following them back is a new question. Rows that predate the
// marker are grandfathered (Barts besluit, 3-8).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');

const BASE = 'https://test.example';
const local = (slug) => `${BASE}/ap/users/${slug}`;
const STRANGER = 'https://elders.example/users/stranger';
const PAL = 'https://elders.example/users/pal';
const OLDPAL = 'https://elders.example/users/oldpal';

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
let n = 0;
function site(slug) {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)')
    .run(`s${++n}`, slug, slug, 'u1', n === 1 ? 1 : 0);
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
}
const guards = (slug, other) =>
  db.prepare("INSERT INTO ap_guardianships (slug, role, other_uri, status) VALUES (?, 'ward', ?, 'accepted')")
    .run(slug, other);
const follower = (slug, uri, gateApproved) =>
  db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox, gate_approved) VALUES (?,?,?,?)')
    .run(slug, uri, `${uri}/inbox`, gateApproved ? 1 : 0);

const kid = site('kid');
site('mum');
guards('kid', local('mum'));          // kid is a ward, watched by mum
follower('kid', PAL, true);           // came through the §5.3 gate
follower('kid', OLDPAL, false);       // followed back when kid was still free

const free = site('freebird');        // no guardians at all

test('a free actor is not gated at all', async () => {
  assert.equal(await AP.gateOutgoingFollow(free, STRANGER), null,
    'guardianship is the only thing that gates a follow; a free account keeps its own counsel');
});

test('a stranger has to wait for the guardians', async () => {
  const held = await AP.gateOutgoingFollow(kid, STRANGER);
  assert.ok(held, 'held, not sent');
  assert.equal(held.status, 'pending');
  assert.equal(held.target_uri, STRANGER);
});

test('following your own guardian needs nobody\'s permission', async () => {
  assert.equal(await AP.gateOutgoingFollow(kid, local('mum')), null,
    'asking mum whether you may follow mum is not a question');
});

test('a follower the guardians already admitted may be followed back', async () => {
  assert.equal(await AP.gateOutgoingFollow(kid, PAL), null,
    'a guardian said yes to this person by name; asking twice teaches people to stop reading');
});

test('but a follower from before the guardians existed is a fresh question', async () => {
  const held = await AP.gateOutgoingFollow(kid, OLDPAL);
  assert.ok(held, 'never went through the gate, so nobody ever vetted them');
  assert.equal(held.status, 'pending');
});

test('asking twice does not queue the same request twice', async () => {
  const again = await AP.gateOutgoingFollow(kid, STRANGER);
  assert.ok(again);
  assert.equal(G.outgoing.listForWard('kid').filter((o) => o.target_uri === STRANGER).length, 1);
});

test('the guardians see it in their own queue, apart from the inbound one', () => {
  const q = G.outgoingFollowsCollection(`${local('kid')}/queues/outgoing-follows`, 'kid', local('mum'));
  const mine = q.orderedItems.filter((o) => o['shaer:target'] === STRANGER);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]['shaer:direction'], 'outgoing',
    'a guardian must be able to tell "wants to follow your ward" from "your ward wants to follow"');
  assert.equal(mine[0]['shaer:myVote'], false);
});

test('a guardian approving lets it through from then on', async () => {
  const pending = G.outgoing.listForWard('kid').find((o) => o.target_uri === STRANGER);
  const r = G.outgoing.decide(pending.id, local('mum'), 'approve', [local('mum')]);
  assert.equal(r.outcome, 'approved');
  assert.equal(await AP.gateOutgoingFollow(kid, STRANGER), null,
    'the row stays behind as the record, so an unfollow and refollow is not a second question');
});

test('a refusal is remembered too, and does not re-ask by re-tapping', async () => {
  const held = await AP.gateOutgoingFollow(kid, OLDPAL);
  const r = G.outgoing.decide(held.id, local('mum'), 'reject', [local('mum')]);
  assert.equal(r.outcome, 'rejected');
  const again = await AP.gateOutgoingFollow(kid, OLDPAL);
  assert.equal(again.status, 'denied', 'tapping follow again does not put it back in front of mum');
});
