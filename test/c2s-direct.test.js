// Direct notes (private mentions, shaer-tqc): never Public, never boostable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const PUB = 'https://www.w3.org/ns/activitystreams#Public';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'me', 'Me', 'u1', 1);
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const user = { id: 'u1', username: 'u1' };

test('a direct outbox row addresses only its recipients, no Public, no cc', () => {
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, visibility, to_actors, created_at)
    VALUES ('d1','me','',NULL,NULL,'https://r.test/u/g','@g@r.test','<p>help</p>','direct','["https://r.test/u/g","https://q.test/u/h"]',CURRENT_TIMESTAMP)`).run();
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get('d1');
  const note = AP.buildReplyNote('https://test.example', site, row);
  assert.deepEqual(note.to, ['https://r.test/u/g', 'https://q.test/u/h']);
  assert.deepEqual(note.cc, []);
  assert.ok(!JSON.stringify(note.to).includes(PUB) && !JSON.stringify(note.cc).includes(PUB));
});

test('a direct note carries its attachments (help-buoy capture)', () => {
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, visibility, to_actors, attachments, created_at)
    VALUES ('d2','me','',NULL,NULL,'https://r.test/u/g','@g@r.test','<p>kijk</p>','direct','["https://r.test/u/g"]','[{"url":"/media/reply-media/x.png","mediaType":"image/png","name":"capture"}]',CURRENT_TIMESTAMP)`).run();
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get('d2');
  const note = AP.buildReplyNote('https://test.example', site, row);
  assert.equal(note.attachment.length, 1);
  assert.equal(note.attachment[0].type, 'Image');
  assert.ok(note.attachment[0].url.endsWith('/media/reply-media/x.png'));
  assert.deepEqual(note.cc, []);   // still direct
});

test('direct without any real recipient is refused (400 no_recipients)', async () => {
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Note', content: '<p>x</p>',
    to: ['https://test.example/ap/users/me/followers'], cc: [],   // friends-shaped? no: followers in to = friends
  });
  // followers-only reads as friends, so force the direct shape: bare unknown string
  const r2 = await AP.ingestOutboxActivity(site, user, { type: 'Note', content: '<p>x</p>', to: [], cc: [] });
  // empty addressing = legacy public; the real no-recipient direct case:
  const r3 = await AP.ingestOutboxActivity(site, user, { type: 'Note', content: '<p>x</p>', to: ['not-a-uri'], cc: [] });
  assert.equal(r3.status, 400);
  assert.equal(r3.error, 'no_recipients');
  assert.ok(r && r2); // shapes above answered too (not the point of this test)
});

test('C2S Announce/Like of a non-public local post is refused (403)', async () => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, fan_only, ap_visibility, created_at, updated_at, published_at)
    VALUES ('pf','s1','geheim','u1','','<p>prive</p>','published','post',1,'friends',datetime('now'),datetime('now'),datetime('now'))`).run();
  const noteUrl = 'https://test.example/ap/notes/pf';
  const boost = await AP.ingestOutboxActivity(site, user, { type: 'Announce', object: noteUrl });
  assert.equal(boost.status, 403);
  assert.equal(boost.error, 'not_public');
  const like = await AP.ingestOutboxActivity(site, user, { type: 'Like', object: noteUrl });
  assert.equal(like.status, 403);
});
