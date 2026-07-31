// FEP-7628 (Move actor, DRAFT) — the inbound half: an account our sites follow
// announces a move, and our follows travel along. All network legs are
// injected; the DB is in-memory, like the other AP tests.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const { handleMoveInbox, buildActor } = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
for (const [id, slug] of [['s1', 'radio'], ['s2', 'blog']]) {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run(id, slug, slug, 'u1', id === 's1' ? 1 : 0);
}

const OLD = 'https://oldhome.example/users/dj';
const NEW = 'https://newhome.example/users/dj';
const STRANGER = 'https://elsewhere.example/users/nosy';

// The target actor doc the mover controls; the alsoKnownAs back-reference is
// the proof both ends belong to the same person.
const targetActor = (aka = [OLD]) => ({ id: NEW, type: 'Person', inbox: `${NEW}/inbox`, alsoKnownAs: aka });
const move = (overrides = {}) => ({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${OLD}#move-1`, type: 'Move', actor: OLD, object: OLD, target: NEW, ...overrides });

// Stubs mirror the DB effect of the real followActor/unfollowActor, so the
// handler's row bookkeeping is exercised without keys or delivery queues.
let calls;
const deps = (aka) => ({
  fetchActorFn: async () => targetActor(aka),
  unfollowFn: async (site, uri) => { calls.unfollow.push([site.slug, uri]); db.prepare('DELETE FROM ap_following WHERE slug = ? AND actor_uri = ?').run(site.slug, uri); },
  followFn: async (site, uri, autoBoost) => { calls.follow.push([site.slug, uri, autoBoost]); db.prepare('INSERT OR REPLACE INTO ap_following (slug, actor_uri, status, auto_boost) VALUES (?,?,?,?)').run(site.slug, uri, 'pending', autoBoost ? 1 : 0); },
});

beforeEach(() => {
  calls = { unfollow: [], follow: [] };
  db.prepare('DELETE FROM ap_following').run();
  db.prepare('DELETE FROM ap_blocks').run();
  db.prepare('INSERT INTO ap_following (slug, actor_uri, status, auto_boost) VALUES (?,?,?,?)').run('radio', OLD, 'accepted', 1);
  db.prepare('INSERT INTO ap_following (slug, actor_uri, status, auto_boost) VALUES (?,?,?,?)').run('blog', OLD, 'accepted', 0);
});

const following = (slug) => db.prepare('SELECT * FROM ap_following WHERE slug = ? ORDER BY actor_uri').all(slug);

test('a third party cannot narrate someone else\'s move', async () => {
  const res = await handleMoveInbox(move(), { verifiedActor: STRANGER, ...deps() });
  assert.equal(res, 401);
  assert.equal(following('radio')[0].actor_uri, OLD);
  assert.equal(calls.follow.length + calls.unfollow.length, 0);
});

test('without the alsoKnownAs back-reference nothing moves', async () => {
  const res = await handleMoveInbox(move(), { verifiedActor: OLD, ...deps([]) });
  assert.equal(res, 202); // declined, not errored: the sender may be retrying in good faith
  assert.equal(following('radio')[0].actor_uri, OLD);
  assert.equal(calls.follow.length + calls.unfollow.length, 0);
});

test('push mode: both sites re-follow, each keeping its own auto-boost', async () => {
  const res = await handleMoveInbox(move(), { verifiedActor: OLD, ...deps() });
  assert.equal(res, 202);
  assert.deepEqual(calls.unfollow.sort(), [['blog', OLD], ['radio', OLD]]);
  assert.deepEqual(calls.follow.sort(), [['blog', NEW, false], ['radio', NEW, true]]);
  assert.equal(following('radio')[0].actor_uri, NEW);
  assert.equal(following('radio')[0].auto_boost, 1);
  assert.equal(following('blog')[0].auto_boost, 0);
});

test('pull mode: the NEW actor may announce the move itself', async () => {
  const res = await handleMoveInbox(move({ actor: NEW, id: `${NEW}#move-1` }), { verifiedActor: NEW, ...deps() });
  assert.equal(res, 202);
  assert.equal(following('radio')[0].actor_uri, NEW);
});

test('redelivery is idempotent: the second Move finds nothing to do', async () => {
  await handleMoveInbox(move(), { verifiedActor: OLD, ...deps() });
  calls = { unfollow: [], follow: [] };
  const res = await handleMoveInbox(move(), { verifiedActor: OLD, ...deps() });
  assert.equal(res, 202);
  assert.equal(calls.follow.length + calls.unfollow.length, 0);
});

test('a site already following the target is not re-followed, old row still cleaned', async () => {
  db.prepare('INSERT INTO ap_following (slug, actor_uri, status, auto_boost) VALUES (?,?,?,?)').run('radio', NEW, 'accepted', 0);
  await handleMoveInbox(move(), { verifiedActor: OLD, ...deps() });
  assert.deepEqual(calls.follow, [['blog', NEW, false]]); // radio skipped
  assert.equal(following('radio').length, 1);             // OLD gone, NEW kept
  assert.equal(following('radio')[0].actor_uri, NEW);
});

test('a blocked destination is declined: no door opens to a blocked house', async () => {
  db.prepare('INSERT INTO ap_blocks (slug, target, kind) VALUES (?,?,?)').run('radio', NEW, 'actor');
  const res = await handleMoveInbox(move(), { verifiedActor: OLD, ...deps() });
  assert.equal(res, 202);
  assert.equal(following('radio')[0].actor_uri, OLD); // untouched
  assert.equal(calls.follow.length + calls.unfollow.length, 0);
});

test('malformed moves are 400: missing target, or object === target', async () => {
  assert.equal(await handleMoveInbox(move({ target: undefined }), { verifiedActor: OLD, ...deps() }), 400);
  assert.equal(await handleMoveInbox(move({ target: OLD }), { verifiedActor: OLD, ...deps() }), 400);
});

test('an unsigned Move is refused before anything is read', async () => {
  const res = await handleMoveInbox(move(), { verifiedActor: null, ...deps() });
  assert.equal(res, 401);
  assert.equal(following('radio')[0].actor_uri, OLD);
});

test('the actor publishes alsoKnownAs from ap_aliases; the own id is filtered out', () => {
  db.prepare("UPDATE sites SET ap_aliases = ? WHERE slug = 'radio'")
    .run(JSON.stringify(['https://oldhome.example/users/dj', 'https://test.example/ap/users/radio', 42]));
  const site = db.prepare("SELECT * FROM sites WHERE slug = 'radio'").get();
  const actor = buildActor('https://test.example', site);
  assert.deepEqual(actor.alsoKnownAs, ['https://oldhome.example/users/dj']);
});

test('no aliases set, no alsoKnownAs on the actor', () => {
  db.prepare("UPDATE sites SET ap_aliases = NULL WHERE slug = 'radio'").run();
  const site = db.prepare("SELECT * FROM sites WHERE slug = 'radio'").get();
  assert.equal('alsoKnownAs' in buildActor('https://test.example', site), false);
});

// ── Slice 2: the OUTGOING half ─────────────────────────────────────
// This Klonkt as the old home. A guarded account refuses (shaer-tge), a
// target without the alsoKnownAs back-reference refuses, and the happy path
// records moved_to and delivers ONE Move to every follower inbox.
const { moveAccount } = await import('../src/services/ActivityPubService.js');
const ME_RADIO = 'https://test.example/ap/users/radio';
const radioSite = () => db.prepare("SELECT * FROM sites WHERE slug = 'radio'").get();

test('a guarded account refuses to move (shaer-tge)', async () => {
  db.prepare(`INSERT OR IGNORE INTO ap_guardianships (slug, role, other_uri, status, offer_id)
              VALUES ('blog', 'ward', 'https://oma.example/u/oma', 'accepted', 'o9')`).run();
  const blogSite = db.prepare("SELECT * FROM sites WHERE slug = 'blog'").get();
  const r = await moveAccount(blogSite, 'https://elders.example/users/nieuw', {
    fetchActorFn: async () => ({ id: 'https://elders.example/users/nieuw', inbox: 'https://elders.example/inbox', alsoKnownAs: ['https://test.example/ap/users/blog'] }),
  });
  assert.equal(r.error, 'guarded_account');
  assert.equal(db.prepare("SELECT moved_to FROM sites WHERE slug = 'blog'").get().moved_to, null, 'nothing recorded');
});

test('without the back-reference the move refuses', async () => {
  const r = await moveAccount(radioSite(), 'https://elders.example/users/nieuw', {
    fetchActorFn: async () => ({ id: 'https://elders.example/users/nieuw', inbox: 'https://elders.example/inbox', alsoKnownAs: ['https://iemand-anders.example/x'] }),
  });
  assert.equal(r.error, 'no_backreference');
  assert.equal(db.prepare("SELECT moved_to FROM sites WHERE slug = 'radio'").get().moved_to, null);
});

test('the happy path: moved_to recorded, one Move to every follower inbox', async () => {
  db.prepare("INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES ('radio', 'https://a.example/u/a', 'https://a.example/inbox')").run();
  db.prepare("INSERT INTO ap_followers (slug, actor_uri, inbox, shared_inbox) VALUES ('radio', 'https://b.example/u/b', 'https://b.example/inbox', 'https://b.example/shared')").run();
  const delivered = [];
  const r = await moveAccount(radioSite(), 'https://elders.example/users/nieuw', {
    fetchActorFn: async () => ({ id: 'https://elders.example/users/nieuw', inbox: 'https://elders.example/inbox', alsoKnownAs: [ME_RADIO] }),
    deliverFn: async (slug, inbox, activity) => { delivered.push({ inbox, activity }); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'https://elders.example/users/nieuw');
  assert.equal(db.prepare("SELECT moved_to FROM sites WHERE slug = 'radio'").get().moved_to, 'https://elders.example/users/nieuw');
  assert.equal(delivered.length, 2, 'both follower inboxes');
  for (const d of delivered) {
    assert.equal(d.activity.type, 'Move');
    assert.equal(d.activity.object, ME_RADIO);
    assert.equal(d.activity.target, 'https://elders.example/users/nieuw');
  }
  assert.ok(delivered.some((d) => d.inbox === 'https://b.example/shared'), 'shared inbox preferred');
});
