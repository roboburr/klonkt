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

test('a duplicate reply is idempotent success with the SAME id, not a 502', async () => {
  const first = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'nogmaals', visibility: 'friends' });
  assert.ok(first && first.id);
  const again = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'nogmaals', visibility: 'friends' });
  assert.ok(again && again.duplicate, 'recognised as a duplicate');
  assert.equal(again.id, first.id, 'and it answers with the existing id, so the ingest 201s');
});
