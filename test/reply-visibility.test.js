// Privacy: private replies (followers-only / direct) mogen NIET in de publieke
// thread op de post-pagina verschijnen; ze horen bij notifications/Messages.
// Dekt noteVisibility() (to/cc parsing) + het getInteractions-filter af.
//
// Run: npm test   (= node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Isoleer van de echte DB: ':memory:' MOET gezet zijn vóór de eerste import van
// config/database.js (die maakt de singleton-connectie op basis van deze env).
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
const AP = await import('../src/services/ActivityPubService.js');

dbMod.initializeDatabase();

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

// ── noteVisibility: to/cc → visibility ──────────────────────────────────
test('Public in to = public', () => {
  assert.equal(AP.noteVisibility({ to: [PUBLIC], cc: ['https://a/followers'] }), 'public');
});
test('Public in cc = unlisted', () => {
  assert.equal(AP.noteVisibility({ to: ['https://a/followers'], cc: [PUBLIC] }), 'unlisted');
});
test('as:Public / Public shorthands tellen ook', () => {
  assert.equal(AP.noteVisibility({ to: ['as:Public'] }), 'public');
  assert.equal(AP.noteVisibility({ cc: ['Public'] }), 'unlisted');
});
test('followers-collectie zonder Public = followers', () => {
  assert.equal(AP.noteVisibility({ to: ['https://mastodon.social/users/a/followers'] }), 'followers');
});
test('alleen personen geadresseerd = direct (DM)', () => {
  assert.equal(AP.noteVisibility({ to: ['https://klonkt.test/ap/users/me'] }), 'direct');
});
test('string ipv array en ontbrekende velden crashen niet', () => {
  assert.equal(AP.noteVisibility({ to: PUBLIC }), 'public');
  assert.equal(AP.noteVisibility({}), 'direct');
  assert.equal(AP.noteVisibility(null), 'direct');
});

// ── getInteractions: private replies uit de publieke thread ─────────────
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run('s1', 'me', 'Me', 'u1');
db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, created_at, updated_at, published_at)
  VALUES ('p1','s1','post','u1','Post','<p>x</p>','published','post',datetime('now'),datetime('now'),datetime('now'))`).run();

function addReply(objectUri, visibility, content) {
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, content, visibility)
    VALUES ('reply','p1',?,?,?,?,?)`).run(objectUri, 'https://remote.test/users/r', 'R', content, visibility);
}
addReply('https://remote.test/n/1', 'public', '<p>publieke reply</p>');
addReply('https://remote.test/n/2', 'unlisted', '<p>unlisted reply</p>');
addReply('https://remote.test/n/3', 'followers', '<p>followers-only reply</p>');
addReply('https://remote.test/n/4', 'direct', '<p>DM reply</p>');
// legacy rij zonder visibility (pre-migratie) → telt als public
db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, content, visibility)
  VALUES ('reply','p1','https://remote.test/n/5','https://remote.test/users/r','R','<p>legacy</p>',NULL)`).run();
// een followers-only like blijft gewoon meetellen (count-only, geen content)
db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, visibility)
  VALUES ('like','p1','','https://remote.test/users/r','followers')`).run();

test('publieke thread bevat public/unlisted/legacy, maar geen followers/direct', () => {
  const view = AP.getInteractions('p1', 'https://klonkt.test', { slug: 'me', title: 'Me' });
  const html = JSON.stringify(view);
  assert.ok(html.includes('publieke reply'));
  assert.ok(html.includes('unlisted reply'));
  assert.ok(html.includes('legacy'));
  assert.ok(!html.includes('followers-only reply'), 'followers-only reply lekte naar de publieke thread');
  assert.ok(!html.includes('DM reply'), 'DM lekte naar de publieke thread');
  assert.equal(view.likeCount, 1, 'like hoort te blijven meetellen');
});

test('private reply blijft zichtbaar voor de eigenaar in notifications (met post-context)', () => {
  const notes = AP.getNotifications('me', 50);
  const dm = notes.find((n) => n.content && n.content.includes('DM reply'));
  assert.ok(dm, 'DM-reply ontbreekt in notifications');
  assert.equal(dm.post_slug, 'post');
  assert.equal(dm.post_title, 'Post');
});
