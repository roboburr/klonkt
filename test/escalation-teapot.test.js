// FEP-633c §4.1 — a malformed guardian must not cost a child the good ones.
//
// A "guardian" that carries guardians of its own is not one (§1). When a ward
// calls for help, an escalation addressed to such an actor goes nowhere: there
// is no grand-guardian to recurse to. The spec's answer is to fail SOFTLY —
// drop that one target, keep delivering to the rest — because the alternative
// is a child whose call for help fails entirely because one adult's account is
// misconfigured.
//
// Klonkt enforced this nowhere until now; the daemon has had it since the
// beginning, which is the divergence shaer-6d9 exists to catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';
const local = (slug) => `${BASE}/ap/users/${slug}`;

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

const kid = site('kid');       // the ward calling for help
site('good');                  // a proper guardian
site('bad');                   // listed as a guardian, but a ward itself
site('gran');                  // who guards `bad`

guards('kid', local('good'));
guards('kid', local('bad'));
guards('bad', local('gran'));  // this is what makes `bad` malformed as a guardian

const help = await AP.deliverDirectNote(kid, {
  recipients: [local('good'), local('bad')],
  text: 'ik snap dit niet', helpRequest: true,
});

test('an escalation skips the malformed guardian and still reaches the others (§4.1)', () => {
  assert.ok(help && help.id, 'the note was built');
  assert.deepEqual(help.teapots, [local('bad')],
    'the dropped target is named — SHOULD log the condition, not swallow it');
  assert.equal(help.delivered, 1,
    'and the well-formed guardian still got it: a malformed target MUST NOT block the others');
});

test('an ordinary direct note is not an escalation, so nobody is dropped', async () => {
  // §4.1 is about escalations. A ward messaging another ward is ordinary
  // conversation, and silently dropping recipients from it would be a bug
  // wearing a spec reference.
  const chat = await AP.deliverDirectNote(kid, { recipients: [local('bad')], text: 'hoi' });
  assert.ok(chat && chat.id);
  assert.deepEqual(chat.teapots, []);
  assert.equal(chat.delivered, 1, 'delivered to a ward, because that is allowed');
});

test('a ward whose every guardian is malformed calls out into nothing', async () => {
  // §4 does not cover this, because §4.1 assumes there are others to continue
  // to. There are not. The call reaches no one, which is the single outcome
  // this FEP exists to prevent — so it fails loudly in the log rather than
  // reporting a delivery that did not happen.
  const orphan = site('orphan');
  guards('orphan', local('bad'));
  const nowhere = await AP.deliverDirectNote(orphan, {
    recipients: [local('bad')], text: 'help', helpRequest: true,
  });
  assert.equal(nowhere, null, 'no note, no false "delivered"');
});
