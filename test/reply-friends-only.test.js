// A reply to a friends-only post, however its address is spelled.
//
// The chain that broke on Shaer (Robins schermafdruk, 2-8: "Server said 502:
// cannot_resolve_inReplyTo"): a friends-visibility post stores fan_only = 1,
// the /ap/notes route hid every fan_only post from EVERYONE without ever
// reading the Signature header, and resolveRemoteNote fetched even the
// server's OWN notes over public HTTPS. So the signed resolution the reply
// path performs knocked on a door that could never open, and every reply to
// a friends-only post (Shaer's default!) died before delivery. Public posts
// resolved fine, which made it look intermittent.
//
// Two fixes, two test groups. One: a note living on this server resolves
// from the DB, no HTTP, in any spelling of our own host (🩵.example IS
// xn--zz9h.example, Barts WebFinger-les). Two: the /ap/notes route now does
// authorized fetch: a verified follower earns the friends-only Note, a
// stranger keeps getting the exact same 404 as before, and 'direct' is never
// served over GET at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://xn--zz9h.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)')
  .run('s1', 'kid', 'kid', 'u1');
const site = db.prepare("SELECT * FROM sites WHERE slug = 'kid'").get();
const user = db.prepare("SELECT * FROM users WHERE id = 'u1'").get();

const insertPost = db.prepare(`INSERT INTO posts
  (id, site_id, slug, author_id, title, content, excerpt, status, type, language, fan_only, ap_visibility, created_at, updated_at, published_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'),datetime('now'))`);
insertPost.run('p-friends', 's1', 'n-friends', 'u1', '', '<p>alleen vrienden</p>', '', 'published', 'post', 'nl', 1, 'friends');
insertPost.run('p-public', 's1', 'n-public', 'u1', '', '<p>iedereen</p>', '', 'published', 'post', 'nl', 0, 'public');
insertPost.run('p-direct', 's1', 'n-direct', 'u1', '', '<p>persoonlijk</p>', '', 'published', 'post', 'nl', 1, 'direct');

const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
test.after(() => server.close());

const apGet = (path, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'application/activity+json', ...headers } });

// ── Eén: de eigen note resolven zonder HTTP ──────────────────────────────

test('a C2S reply to the own friends-only post resolves its parent locally', async () => {
  // There is no server behind xn--zz9h.example: if the parent resolution
  // still went over HTTP this would 502. It resolves from the DB instead.
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note', content: '<p>hoi</p>', source: { content: 'hoi' },
      inReplyTo: 'https://xn--zz9h.example/ap/notes/p-friends',
      to: ['https://xn--zz9h.example/ap/users/kid/followers'], cc: [],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r));
  // And it threads under the post: findThreadTarget recognized the URL as ours.
  const row = db.prepare('SELECT post_id FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(row && row.post_id, 'p-friends');
});

test('the unicode spelling of our own host is still our own host', async () => {
  // Foundation, Node and every browser silently punycode a URL; a typed one
  // arrives verbatim. Both spellings must reach the same parent (the same
  // lesson WebFinger learned on 2-8, now on the reply path).
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note', content: '<p>nogmaals</p>', source: { content: 'nogmaals' },
      inReplyTo: 'https://\u{1FA75}.example/ap/notes/p-friends',   // 🩵.example ⇒ xn--zz9h.example
      to: ['https://xn--zz9h.example/ap/users/kid/followers'], cc: [],
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r));
  const row = db.prepare('SELECT post_id FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(row && row.post_id, 'p-friends');
});

test('a reply to a nonexistent own note still fails, loudly', async () => {
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note', content: '<p>niks</p>', source: { content: 'niks' },
      inReplyTo: 'https://xn--zz9h.example/ap/notes/bestaat-niet',
      to: ['https://xn--zz9h.example/ap/users/kid/followers'], cc: [],
    },
  });
  assert.equal(r.status, 502);
  assert.equal(r.error, 'cannot_resolve_inReplyTo');
});

// ── Twee: de leespoort (authorized fetch) ────────────────────────────────

test('mayReadNote: the full matrix', () => {
  const friends = { fan_only: 1, ap_visibility: 'friends' };
  const direct = { fan_only: 1, ap_visibility: 'direct' };
  const pub = { fan_only: 0, ap_visibility: 'public' };
  const oma = 'https://elders.example/ap/users/oma';
  db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)')
    .run('kid', oma, 'https://elders.example/inbox');

  assert.equal(AP.mayReadNote(site, pub, null), true, 'public needs nobody');
  assert.equal(AP.mayReadNote(site, friends, oma), true, 'a follower earns the friends-only note');
  assert.equal(AP.mayReadNote(site, friends, 'https://elders.example/ap/users/vreemde'), false, 'a stranger does not');
  assert.equal(AP.mayReadNote(site, friends, null), false, 'no verified actor, no note');
  assert.equal(AP.mayReadNote(site, direct, oma), false, 'direct is never served over GET');

  // A blocked actor's signed fetch earns the empty set (the standing rule),
  // follower row or not.
  db.prepare("INSERT INTO ap_blocks (slug, target, kind) VALUES ('kid', ?, 'actor')").run(oma);
  assert.equal(AP.mayReadNote(site, friends, oma), false, 'actor block wins from the follower row');
  db.prepare('DELETE FROM ap_blocks').run();
  db.prepare("INSERT INTO ap_blocks (slug, target, kind) VALUES ('kid', 'elders.example', 'domain')").run();
  assert.equal(AP.mayReadNote(site, friends, oma), false, 'domain block covers its actors');
  db.prepare('DELETE FROM ap_blocks').run();
});

test('the route: a stranger keeps the exact same 404, public stays public', async () => {
  // Unsigned: the friends-only note does not exist for you.
  assert.equal((await apGet('/ap/notes/p-friends')).status, 404);
  // A signature that cannot be verified is no signature. The keyId points at
  // a blocked IP so the SSRF guard refuses it instantly: same null outcome as
  // an unreachable host, without a DNS lookup that can hang the test.
  assert.equal((await apGet('/ap/notes/p-friends', {
    Signature: 'keyId="https://127.0.0.1:1/u/x#main-key",algorithm="rsa-sha256",headers="(request-target) host date",signature="aGVsbG8="',
    Date: new Date().toUTCString(),
  })).status, 404);
  // Direct is addressed to people: never served over GET, signed or not.
  assert.equal((await apGet('/ap/notes/p-direct')).status, 404);
  // And the public post is untouched by the gate.
  const pub = await apGet('/ap/notes/p-public');
  assert.equal(pub.status, 200);
  const note = await pub.json();
  assert.equal(note.id, 'https://xn--zz9h.example/ap/notes/p-public');
});
