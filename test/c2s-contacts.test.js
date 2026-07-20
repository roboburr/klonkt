// Owner followers/following carry display (name + avatar), not bare URIs
// (shaer-aa3): name -> preferredUsername -> id.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

test('a followed account resolves to its cached name + icon', () => {
  db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, name, icon, status) VALUES (?,?,?,?,?,?)`)
    .run('me', 'https://r.test/u/anna', '@anna@r.test', 'Anna de Vries', 'https://r.test/anna.png', 'accepted');
  const ref = AP.buildActorRef('me', 'https://r.test/u/anna');
  assert.equal(ref.id, 'https://r.test/u/anna');
  assert.equal(ref.name, 'Anna de Vries');
  assert.equal(ref.preferredUsername, 'anna');
  assert.equal(ref.icon.url, 'https://r.test/anna.png');
});

test('a follower with cached display shows it', () => {
  db.prepare(`INSERT INTO ap_followers (slug, actor_uri, name, handle, icon) VALUES (?,?,?,?,?)`)
    .run('me', 'https://q.test/u/ben', 'Ben', '@ben@q.test', 'https://q.test/ben.png');
  const ref = AP.buildActorRef('me', 'https://q.test/u/ben');
  assert.equal(ref.name, 'Ben');
  assert.equal(ref.preferredUsername, 'ben');
});

test('an unknown actor falls back to id + derived username, no name', () => {
  const ref = AP.buildActorRef('me', 'https://x.test/users/cas');
  assert.equal(ref.id, 'https://x.test/users/cas');
  assert.equal(ref.name, undefined);            // no invented name
  assert.equal(ref.preferredUsername, 'cas');   // from the handle
});

test('interaction cache is used when a follower has no own display row', () => {
  db.prepare(`INSERT INTO ap_followers (slug, actor_uri) VALUES ('me','https://r.test/u/dana')`).run();
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, actor_uri, actor_name, actor_handle, actor_icon, created_at)
    VALUES ('like','p','https://r.test/u/dana','Dana','@dana@r.test','https://r.test/dana.png',CURRENT_TIMESTAMP)`).run();
  const ref = AP.buildActorRef('me', 'https://r.test/u/dana');
  assert.equal(ref.name, 'Dana');
});
