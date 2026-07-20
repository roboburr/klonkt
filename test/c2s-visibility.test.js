// C2S visibility (shaer-60b): the note's to/cc addressing decides how a post
// federates. friends/direct ride the fan_only pipeline; quiet puts Public in
// cc (unlisted); no addressing keeps the legacy public behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const PUB = 'https://www.w3.org/ns/activitystreams#Public';
const F = 'https://test.example/ap/users/me/followers';

test('addressing maps to the right visibility bucket', () => {
  assert.equal(AP.c2sVisibility({ to: [PUB] }), 'public');
  assert.equal(AP.c2sVisibility({ to: [F], cc: [PUB] }), 'quiet');
  assert.equal(AP.c2sVisibility({ to: [F] }), 'friends');
  assert.equal(AP.c2sVisibility({ to: ['https://a.test/u/x'] }), 'direct');
  assert.equal(AP.c2sVisibility({}), 'public');            // legacy client
  assert.equal(AP.c2sVisibility({ to: PUB }), 'public');   // bare string form
});

test('a quiet post addresses followers in to and Public in cc', () => {
  const site = { slug: 'me', primary_slug: 'me' };
  const post = { id: 'p1', slug: 'x', title: '', content: '<p>hi</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z', ap_visibility: 'quiet' };
  const note = AP.buildNote('https://test.example', site, post);
  assert.deepEqual(note.to, [F]);
  assert.ok(note.cc.includes(PUB), 'Public rides in cc');
});

test('a friends (fan_only) post never addresses Public', () => {
  const site = { slug: 'me', primary_slug: 'me' };
  const post = { id: 'p2', slug: 'y', title: '', content: '<p>hi</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z', fan_only: 1, ap_visibility: 'friends' };
  const note = AP.buildNote('https://test.example', site, post);
  assert.deepEqual(note.to, [F]);
  assert.ok(!note.cc.includes(PUB));
});
