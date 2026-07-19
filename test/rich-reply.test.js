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

test('rich edit: content replaced, language updated, attachments survive', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: 'origineel', html: '',
    attachments: [{ url: '/media/reply-media/keep.webp', mediaType: 'image/webp', name: 'blijft' }],
    language: 'nl',
  });
  const upd = await AP.deliverOutboxUpdate(site, r.id, '', { html: '<p>bewerkt met <em>nadruk</em></p>', language: 'en' });
  assert.ok(upd && upd.ok);
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /bewerkt met <em>nadruk<\/em>/);
  assert.match(row.content, /^<p><a [^>]*class="u-url mention"/); // mention re-attached inline
  assert.equal(row.language, 'en');
  assert.equal(JSON.parse(row.attachments)[0].url, '/media/reply-media/keep.webp');
});

test('plain edit path unchanged; bogus language keeps the old one', async () => {
  const r = await AP.deliverReply(site, { postId: 'p1', postSlug: 'hallo', parent, text: 'plain start', language: 'nl' });
  const upd = await AP.deliverOutboxUpdate(site, r.id, 'plain bewerkt', { language: '???' });
  assert.ok(upd && upd.ok);
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /plain bewerkt/);
  assert.equal(row.language, 'nl');
});

test('participants: node author plus ancestor chain, deduped, self skipped', () => {
  db.prepare(`INSERT INTO ap_interactions (post_id, kind, actor_uri, actor_handle, actor_url, content, object_uri, parent_uri, visibility)
              VALUES ('p1','reply','https://a.test/u/alice','@alice@a.test','https://a.test/@alice','<p>top</p>','https://a.test/n/1',NULL,'public')`).run();
  db.prepare(`INSERT INTO ap_interactions (post_id, kind, actor_uri, actor_handle, actor_url, content, object_uri, parent_uri, visibility)
              VALUES ('p1','reply','https://b.test/u/bob','@bob@b.test','https://b.test/@bob','<p>kind</p>','https://b.test/n/2','https://a.test/n/1','public')`).run();
  const { thread } = AP.getInteractions('p1', 'https://klonkt.test', site);
  const top = thread.find((n) => n.noteId === 'https://a.test/n/1');
  const child = top.children.find((n) => n.noteId === 'https://b.test/n/2');
  assert.deepEqual(top.participants.map((p) => p.uri), ['https://a.test/u/alice']);
  assert.deepEqual(child.participants.map((p) => p.uri), ['https://b.test/u/bob', 'https://a.test/u/alice']);
  assert.equal(child.participants[1].handle, '@alice@a.test');
});

test('kept mentions: prefix carries every chip, tags follow, to_actor = parent', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: 'hoi allebei',
    mentions: [
      { uri: parent.actor_uri, url: parent.actor_url, handle: parent.actor_handle },
      { uri: 'https://b.test/u/bob', url: 'https://b.test/@bob', handle: '@bob@b.test' },
    ],
  });
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(row.to_actor, parent.actor_uri);
  const note = AP.buildReplyNote('https://klonkt.test', site, row);
  const mentionTags = note.tag.filter((t) => t.type === 'Mention');
  assert.deepEqual(mentionTags.map((t) => t.href).sort(), [parent.actor_uri, 'https://b.test/u/bob'].sort());
});

test('parent removed from the bar: no mention prefix for it, note goes public-only', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: 'zonder ping', mentions: [],
  });
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.equal(row.to_actor, null);
  assert.doesNotMatch(row.content, /u-url mention/);
  const note = AP.buildReplyNote('https://klonkt.test', site, row);
  assert.deepEqual(note.to, ['https://www.w3.org/ns/activitystreams#Public']);
  assert.equal(note.tag.filter((t) => t.type === 'Mention').length, 0);
});

test('editing a multi-mention reply keeps every co-mention', async () => {
  const r = await AP.deliverReply(site, {
    postId: 'p1', postSlug: 'hallo', parent, text: 'multi',
    mentions: [
      { uri: parent.actor_uri, url: parent.actor_url, handle: parent.actor_handle },
      { uri: 'https://b.test/u/bob', url: 'https://b.test/@bob', handle: '@bob@b.test' },
    ],
  });
  const upd = await AP.deliverOutboxUpdate(site, r.id, '', { html: '<p>aangepast</p>' });
  assert.ok(upd && upd.ok);
  const row = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  assert.match(row.content, /aangepast/);
  const note = AP.buildReplyNote('https://klonkt.test', site, row);
  assert.deepEqual(note.tag.filter((t) => t.type === 'Mention').map((t) => t.href).sort(),
    [parent.actor_uri, 'https://b.test/u/bob'].sort());
});
