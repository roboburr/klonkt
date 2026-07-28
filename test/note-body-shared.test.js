// One post, one rendering. De Krant, Berichten and the Guardian PWA all run a
// note through partials/note-body, so a quote card, a link preview, the media
// and the custom emojis show up wherever the post turns up — not only in the
// feed it happened to arrive in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const { renderNoteBody } = await import('../src/middleware/render.js');
const AP = (await import('../src/services/ActivityPubService.js')).default;

const VIEWS = path.join(process.cwd(), 'src', 'views', 'partials');
const EMOJI = JSON.stringify({ ':party:': 'https://cdn.test/party.png' });
const MEDIA = JSON.stringify([{ url: 'https://cdn.test/capture.png', type: 'image/png' }]);
const QUOTE = JSON.stringify({ url: 'https://q.test/notes/7', author: { name: 'Opie', handle: '@opie@q.test' }, content: '<p>het origineel</p>', media: [] });
const EMBED = JSON.stringify({ url: 'https://video.test/watch?v=1', title: 'Een filmpje', provider: 'video.test', media: [{ url: 'https://video.test/thumb.jpg', type: 'image/jpeg' }] });

test('the content renders with its custom emojis', () => {
  const html = renderNoteBody({ content: '<p>hoi :party:</p>', emoji_json: EMOJI }, 'nl');
  assert.match(html, /class="tl-content"/);
  assert.match(html, /<img[^>]+class="emoji"[^>]+party\.png/, ':party: became an image, not a shortcode');
});

test('a quoted post renders as the quote card', () => {
  const html = renderNoteBody({ content: '<p>kijk</p>', quote_json: QUOTE }, 'nl');
  assert.match(html, /class="tl-quote"/);
  assert.match(html, /het origineel/);
  assert.match(html, /@opie@q\.test/);
});

test('an external link preview renders as that same card, with the title escaped', () => {
  const html = renderNoteBody({ content: '<p>kijk</p>', embed_json: EMBED }, 'nl');
  assert.match(html, /class="tl-quote"/, 'one card for both, only the origin differs');
  assert.match(html, /Een filmpje/);
  assert.ok(!/<iframe/i.test(html), 'a preview is a thumbnail, never an embedded player');
});

test('a quote wins over a link preview: only one card', () => {
  const html = renderNoteBody({ content: '<p>x</p>', quote_json: QUOTE, embed_json: EMBED }, 'nl');
  assert.equal((html.match(/class="tl-quote"/g) || []).length, 1);
  assert.match(html, /het origineel/);
  assert.ok(!html.includes('Een filmpje'));
});

test('media renders, and a sensitive note keeps its veil', () => {
  const plain = renderNoteBody({ content: '<p>x</p>', media_json: MEDIA }, 'nl');
  assert.match(plain, /class="tl-media-img"/);
  const nsfw = renderNoteBody({ content: '<p>x</p>', media_json: MEDIA, nsfw: 1, cw: 'spoiler' }, 'nl');
  assert.match(nsfw, /nsfw-media/, 'the veil survives outside de Krant too');
});

test('an empty note renders nothing at all', () => {
  assert.equal(renderNoteBody({ content: '' }, 'nl'), '');
  assert.equal(renderNoteBody(null, 'nl'), '');
});

test('de Krant and Berichten both go through the shared partial', () => {
  for (const f of ['tl-item.ejs', 'msg-item.ejs']) {
    const src = fs.readFileSync(path.join(VIEWS, f), 'utf8');
    assert.match(src, /partials\/note-body/, `${f} must render a post through the shared partial`);
    assert.ok(!/class="tl-media-img"/.test(src), `${f} must not carry its own copy of the media markup`);
  }
});

test('Berichten receives the columns that partial needs', () => {
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'me', 'Me', 'u1', 1);
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, actor_handle, content, emoji_json, media_json, quote_json, help_request)
              VALUES ('me','https://r.test/notes/1','https://r.test/u/a','Anna','@a@r.test','<p>hoi :party:</p>',?,?,?,1)`).run(EMOJI, MEDIA, QUOTE);
  const m = AP.getNotifications('me', 20).find((n) => n.type === 'mention');
  assert.ok(m);
  assert.equal(m.emoji_json, EMOJI);
  assert.equal(m.media_json, MEDIA);
  assert.equal(m.quote_json, QUOTE);
  assert.equal(m.help_request, 1, 'so Berichten can mark a 🛟 as one');
  // The proof: the same object, handed to the same renderer, comes out whole.
  const html = renderNoteBody(m, 'nl');
  assert.match(html, /party\.png/);
  assert.match(html, /class="tl-quote"/);
  assert.match(html, /class="tl-media-img"/);
});
