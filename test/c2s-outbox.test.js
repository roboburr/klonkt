// ActivityPub C2S — ingestOutboxActivity dispatch. Covers the deterministic,
// no-network paths: top-level Note creation (real DB), bare-object wrapping, and
// input validation. Network verbs (Like/Announce/Follow/Undo, replies) are
// verified live against a running server; safeFetch's SSRF pre-flight makes them
// non-deterministic to unit-test.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
const AP = await import('../src/services/ActivityPubService.js');
dbMod.initializeDatabase();

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'r@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('me');
const user = db.prepare('SELECT * FROM users WHERE id = ?').get('u1');

test('Create(Note) top-level → a published post with sanitized content', async () => {
  const out = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: { type: 'Note', content: '<p>Hallo fediverse <script>alert(1)</script></p>' },
  });
  assert.equal(out.status, 201);
  assert.ok(out.id);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(out.id);
  assert.equal(post.status, 'published');
  assert.equal(post.site_id, 's1');
  assert.match(post.content, /Hallo fediverse/);
  assert.doesNotMatch(post.content, /<script>/i); // sanitized
});

test('a bare Note (no Create wrapper) is wrapped and posted', async () => {
  const out = await AP.ingestOutboxActivity(site, user, { type: 'Note', content: '<p>bare note</p>' });
  assert.equal(out.status, 201);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(out.id);
  assert.match(post.content, /bare note/);
});

test('empty note → 400', async () => {
  const out = await AP.ingestOutboxActivity(site, user, { type: 'Create', object: { type: 'Note', content: '' } });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'empty_note');
});

test('unsupported activity type → 400 with detail', async () => {
  const out = await AP.ingestOutboxActivity(site, user, { type: 'Arrive', object: 'x' });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'unsupported_type');
  assert.equal(out.detail, 'Arrive');
});

test('Like/Announce/Follow without an object → 400', async () => {
  for (const type of ['Like', 'Announce', 'Follow']) {
    const out = await AP.ingestOutboxActivity(site, user, { type, object: null });
    assert.equal(out.status, 400, type);
    assert.equal(out.error, 'missing_object', type);
  }
});

test('Undo of an unknown inner type → 400', async () => {
  const out = await AP.ingestOutboxActivity(site, user, { type: 'Undo', object: { type: 'Block', object: 'x' } });
  assert.equal(out.status, 400);
  assert.equal(out.error, 'unsupported_undo');
});

test('garbage input → 400, never throws', async () => {
  assert.equal((await AP.ingestOutboxActivity(site, user, null)).status, 400);
  assert.equal((await AP.ingestOutboxActivity(site, user, 'nope')).status, 400);
  assert.equal((await AP.ingestOutboxActivity(site, user, { type: 'Create' })).error, 'missing_object');
});
