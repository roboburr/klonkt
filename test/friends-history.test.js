// Friends get the history (Robins besluit, 30-7). A friends-only post used to
// be a moment-snapshot: delivered to the followers of that instant, hidden
// from the outbox, so a friend added LATER could never see it in a feed. Now
// the outbox answers by audience, and the backfill a fresh follow triggers
// identifies itself, so the past comes along with the friendship.
//
// And the door stays a door: a verified caller this instance BLOCKS gets an
// EMPTY collection, not even the public set.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'kid', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');

const FRIEND = 'https://vriend.test/u/f';
const STRANGER = 'https://vreemde.test/u/x';
const BLOCKED = 'https://pest.test/u/b';
db.prepare("INSERT INTO ap_followers (slug, actor_uri) VALUES ('kid', ?)").run(FRIEND);
db.prepare("INSERT INTO ap_blocks (slug, kind, target) VALUES ('kid', 'actor', ?)").run(BLOCKED);

test('the audience decides what the outbox holds', () => {
  assert.equal(AP.outboxAudience('kid', {}), 'public', 'anonymous stays public');
  assert.equal(AP.outboxAudience('kid', { verifiedActor: STRANGER }), 'public',
    'a signature alone earns nothing: identification is not friendship');
  assert.equal(AP.outboxAudience('kid', { verifiedActor: FRIEND }), 'friend',
    'an accepted follower reads the friends-only history');
  assert.equal(AP.outboxAudience('kid', { bearerSlug: 'kid' }), 'friend',
    'the owner sees their own friends-only posts in their own app');
  assert.equal(AP.outboxAudience('kid', { bearerSlug: 'someone-else' }), 'public',
    "another local account's bearer is not this account");
});

test('a blocked actor who signs their fetch gets an empty set, not the public one', () => {
  assert.equal(AP.outboxAudience('kid', { verifiedActor: BLOCKED }), 'blocked',
    'the block outranks everything: a closed door, and they knocked with their name on it');
});

test('a blocked FOLLOWER is still blocked: the block outranks the follow', () => {
  // The row order of checks matters: someone blocked after having followed
  // must not keep reading through the stale follower row.
  db.prepare("INSERT INTO ap_followers (slug, actor_uri) VALUES ('kid', ?)").run(BLOCKED);
  assert.equal(AP.outboxAudience('kid', { verifiedActor: BLOCKED }), 'blocked');
});
