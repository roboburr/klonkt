// Your own sent replies must come BACK over C2S (Robins melding, 30-7):
// a reply that stores fine but never shows in the app reads as "replyen
// werkt niet", gets retried, and the retry hit the duplicate guard which
// answered without an id — which the ingest then called 502 reply_failed.
// Two guarantees here: getSentNotes serves the reply as an AS2 Note the
// app can thread, and a duplicate is idempotent success with the same id.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'r@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('me');
const parent = {
  id: 1, post_id: '', actor_uri: 'https://unresolvable.invalid/u/ness',
  actor_url: 'https://unresolvable.invalid/@ness', actor_handle: '@ness@unresolvable.invalid',
  object_uri: 'https://unresolvable.invalid/notes/9',
};

test('a sent reply comes back as a threadable AS2 Note', async () => {
  const r = await AP.deliverReply(site, {
    postId: '', postSlug: null, parent, text: 'test', visibility: 'friends',
    attachments: [{ url: '/media/reply-media/foto.jpg', mediaType: 'image/jpeg', name: 'kiek' }],
  });
  assert.ok(r && r.id, 'the reply stored');

  const notes = AP.getSentNotes('https://klonkt.test', site);
  const note = notes.find((n) => n.id.endsWith(r.id));
  assert.ok(note, 'getSentNotes serves it');
  assert.equal(note.inReplyTo, parent.object_uri, 'threads under the parent');
  assert.ok(note.to.includes(parent.actor_uri), 'addressed to the parent author: the app finds the counterpart');
  assert.ok((note.tag || []).some((t) => t.type === 'Mention' && t.href === parent.actor_uri), 'and the Mention tag agrees');
  const att = (note.attachment || []).find((a) => a.url.endsWith('foto.jpg'));
  assert.ok(att && att.type === 'Image', 'the media rides along, absolute');
  assert.match(String(note.published), /T.*Z$/, 'published is ISO, so the merged feed sorts');
});

test("an inbound reply on your post reaches the app's message stream", () => {
  // The other half of "komt niet binnen bij de ander": inbound replies live
  // in ap_interactions (web comments), never in ap_mentions, so the C2S read
  // never served them. getReplyMessages is the leg that does.
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at, created_at, updated_at)
              VALUES ('p9','s1','u1','n-p9','', '<p>x</p>','published',datetime('now'),datetime('now'),datetime('now'))`).run();
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, content, published, parent_uri, visibility, media_json, created_at)
              VALUES ('reply','p9','https://unresolvable.invalid/notes/77','https://unresolvable.invalid/u/ness','Ness','@ness@unresolvable.invalid','<p>hoi terug</p>','2026-07-30T12:00:00Z','https://klonkt.test/ap/notes/p9','followers','[{"url":"https://unresolvable.invalid/m/f.jpg","type":"image/jpeg"}]',CURRENT_TIMESTAMP)`).run();
  const rows = AP.getReplyMessages('me', 60);
  const r = rows.find((x) => x.object_uri === 'https://unresolvable.invalid/notes/77');
  assert.ok(r, 'the reply is served for the post owner');
  assert.equal(r.parent_uri, 'https://klonkt.test/ap/notes/p9', 'threads under the post');
  assert.equal(r.actor_handle, '@ness@unresolvable.invalid');
  assert.ok(r.media_json.includes('f.jpg'), 'its media rides along');
  assert.equal(AP.getReplyMessages('bestaat-niet', 60).length, 0, 'and only for the post owner');
});

test('a duplicate reply is idempotent success with the SAME id, not a 502', async () => {
  const first = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'nogmaals', visibility: 'friends' });
  assert.ok(first && first.id);
  const again = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'nogmaals', visibility: 'friends' });
  assert.ok(again && again.duplicate, 'recognised as a duplicate');
  assert.equal(again.id, first.id, 'and it answers with the existing id, so the ingest 201s');
});
