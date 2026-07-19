// Rich replies (klonkt-demo-c7f fase 2): deliverReply accepts editor HTML,
// sanitizes it, injects the parent mention into the first paragraph, stores the
// reply language, and buildReplyNote carries contentMap. In-memory DB; the
// parent actor lives on an unresolvable host, so delivery just queues.

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
db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, created_at, updated_at)
            VALUES ('p1','s1','hallo','u1','Hallo','<p>x</p>','published',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run();

const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('me');
const parent = {
  id: 1, post_id: 'p1', actor_uri: 'https://unresolvable.invalid/u/alice',
  actor_url: 'https://unresolvable.invalid/@alice', actor_handle: '@alice@unresolvable.invalid',
  object_uri: 'https://unresolvable.invalid/notes/1',
};

test('rich html is sanitized, mention lands in the first paragraph, language stored', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent,
    text: '', html: '<p>Dag <strong>Alice</strong>!</p><script>evil()</script>',
    language: 'nl',
  });
  assert.ok(r && r.id, 'reply stored');
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /<strong>Alice<\/strong>/);
  assert.doesNotMatch(row.content, /<script/i);
  assert.match(row.content, /^<p><a [^>]*class="u-url mention"/); // mention in first <p>
  assert.equal(row.language, 'nl');

  const note = AP.buildReplyNote('https://klonkt.test', site, row);
  assert.equal(note.type, 'Note');
  assert.deepEqual(Object.keys(note.contentMap), ['nl']);
  assert.equal(note.contentMap.nl, note.content);
});

test('rich html without a leading <p> gets the mention as its own paragraph', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent,
    text: '', html: '<blockquote>quote</blockquote>', language: '',
  });
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /^<p><a .*<\/p><blockquote>/s);
  assert.equal(row.language, null);
  assert.equal(AP.buildReplyNote('https://klonkt.test', site, row).contentMap, undefined);
});

test('the plain-text path is unchanged (escaped, br for newlines)', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: 'plain <b>niet</b>\ntweede',
  });
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /plain &lt;b&gt;niet&lt;\/b&gt;<br>tweede/);
});

test('empty rich html (only tags/whitespace) is rejected like empty text', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: '', html: '<p>   </p><script>x()</script>',
  });
  assert.equal(r, null);
});

test('a bogus language code is dropped, not stored', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: '', html: '<p>taalcheck</p>', language: 'not a lang!',
  });
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(row.language, null);
});

test('attachments: own /media/ urls stored, note carries typed absolute attachments', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: 'met media', html: '',
    attachments: [
      { url: '/media/reply-media/a.webp', mediaType: 'image/webp', name: 'foto' },
      { url: '/media/reply-media/b.mp3', mediaType: 'audio/mpeg', name: 'liedje' },
      { url: 'https://evil.example/x.png', mediaType: 'image/png', name: 'remote' },  // rejected: not ours
      { url: '/media/reply-media/c.pdf', mediaType: 'application/pdf', name: 'doc' }, // rejected: type
    ],
  });
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  const stored = JSON.parse(row.attachments);
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((a) => a.url), ['/media/reply-media/a.webp', '/media/reply-media/b.mp3']);

  const note = AP.buildReplyNote('https://klonkt.test', site, row);
  assert.equal(note.attachment.length, 2);
  assert.deepEqual(note.attachment.map((a) => a.type), ['Image', 'Audio']);
  assert.equal(note.attachment[0].url, 'https://klonkt.test/media/reply-media/a.webp');
});

test('a media-only reply (no text) is delivered', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: '', html: '',
    attachments: [{ url: '/media/reply-media/solo.webp', mediaType: 'image/webp', name: '' }],
  });
  assert.ok(r && r.id);
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /^<p><a /); // just the mention paragraph
  assert.equal(JSON.parse(row.attachments).length, 1);
});

test('only foreign/invalid attachments and no text -> rejected', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: '', html: '',
    attachments: [{ url: 'https://evil.example/x.png', mediaType: 'image/png' }],
  });
  assert.equal(r, null);
});
