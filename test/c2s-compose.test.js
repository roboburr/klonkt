// The app's composer posts over C2S. A top-level Note with media used to lose
// it silently: c2sCreatePost read only the content, so a photo post arrived
// naked while the very same attachments worked fine on replies and DMs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('s1' ? 'kid' : 'kid');
const user = db.prepare('SELECT * FROM users WHERE id = ?').get('u1');

test('a C2S post carries its media: into the web content and out as AS2 attachments', async () => {
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note',
      content: '<p>kijk dan</p>',
      source: { content: 'kijk dan', mediaType: 'text/plain' },
      to: ['https://test.example/ap/users/kid/followers'],
      cc: ['https://www.w3.org/ns/activitystreams#Public'],
      attachment: [
        { type: 'Image', url: '/media/reply-media/foto.jpg', mediaType: 'image/jpeg', name: 'ons plein' },
        { type: 'Audio', url: '/media/reply-media/opname.m4a', mediaType: 'audio/mp4' },
        // Not ours: a remote URL must never be laundered into our media.
        { type: 'Image', url: 'https://evil.test/x.jpg', mediaType: 'image/jpeg' },
      ],
    },
  });
  assert.equal(r.status, 201, 'the post is created');

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
  assert.match(post.content, /<img src="\/media\/reply-media\/foto\.jpg" alt="ons plein">/, 'the web shows the photo');
  assert.match(post.content, /<audio controls[^>]+src="\/media\/reply-media\/opname\.m4a">/, 'and plays the recording');
  assert.ok(!post.content.includes('evil.test'), 'the stranger stays out');

  const note = AP.buildNote('https://test.example', site, post);
  // The FEDERATED content carries no media tags: they ride as attachments,
  // and the tags' relative /media srcs are dead everywhere but our own web.
  // Leaving them in showed every remote reader a broken player above the
  // working one (Robins schermafdruk, 30-7).
  assert.ok(!/<(video|audio|img)\b/i.test(note.content), 'the note content is clean of media tags');
  const att = note.attachment || [];
  const img = att.find((a) => a.url.endsWith('/media/reply-media/foto.jpg'));
  const aud = att.find((a) => a.url.endsWith('/media/reply-media/opname.m4a'));
  assert.ok(img && img.type === 'Image', 'the photo federates as an Image');
  assert.equal(img.url, 'https://test.example/media/reply-media/foto.jpg', 'absolute, so any server can fetch it');
  assert.equal(img.name, 'ons plein', 'alt text rides along');
  assert.ok(aud, 'the recording federates too');
  assert.equal(aud.type, 'Audio', 'as an Audio, not an Image: the stored mediaType wins over the extension map');
  assert.equal(att.filter((a) => a.url.endsWith('foto.jpg')).length, 1, 'inline img + stored row dedupe to one');
});

test("a video's poster frame rides the tag, the store and the federated attachment", async () => {
  // The upload leg writes <name>.poster.jpg next to a video when ffmpeg is
  // around (shaer-zowq). From there it must reach three places: the poster=
  // on the folded tag (web), the stored entry, and the AS2 icon on the
  // federated attachment (apps and other servers).
  const os = await import('os');
  const fsm = await import('fs');
  const pathm = await import('path');
  const root = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'klonkt-media-'));
  fsm.mkdirSync(pathm.join(root, 'reply-media'), { recursive: true });
  fsm.writeFileSync(pathm.join(root, 'reply-media', 'film.mp4.poster.jpg'), 'x');
  const prev = process.env.MEDIA_PATH;
  process.env.MEDIA_PATH = root;
  try {
    const r = await AP.ingestOutboxActivity(site, user, {
      type: 'Create',
      object: {
        type: 'Note', content: '<p>filmpje</p>',
        to: ['https://test.example/ap/users/kid/followers'],
        attachment: [{ type: 'Video', url: '/media/reply-media/film.mp4', mediaType: 'video/mp4' }],
      },
    });
    assert.equal(r.status, 201);
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
    assert.match(post.content, /poster="\/media\/reply-media\/film\.mp4\.poster\.jpg"/, 'the web tag shows the still');
    const note = AP.buildNote('https://test.example', site, post);
    const vid = (note.attachment || []).find((a) => a.url.endsWith('film.mp4'));
    assert.ok(vid && vid.type === 'Video');
    assert.equal(vid.icon && vid.icon.url, 'https://test.example/media/reply-media/film.mp4.poster.jpg',
      'the poster federates as the attachment icon');
    // NO cover (Robins besluit): a cover next to the content showed the same
    // video twice on the post page. The tiles derive their picture from the
    // content (post-tile/post-card), so the post model stays single-source.
    assert.equal(post.cover_video_url, null);
    assert.equal(post.cover_image_url, null);
    assert.equal((note.attachment || []).filter((a) => a.url.endsWith('film.mp4')).length, 1,
      'and the video federates exactly once');
  } finally {
    if (prev === undefined) delete process.env.MEDIA_PATH; else process.env.MEDIA_PATH = prev;
  }
});

test('a video without a poster simply has none: no guessed icon', async () => {
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note', content: '<p>kaal</p>',
      to: ['https://test.example/ap/users/kid/followers'],
      attachment: [{ type: 'Video', url: '/media/reply-media/zonder.mp4', mediaType: 'video/mp4' }],
    },
  });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
  assert.ok(!post.content.includes('poster='), 'no poster attr without a poster file');
  const vid = (AP.buildNote('https://test.example', site, post).attachment || []).find((a) => a.url.endsWith('zonder.mp4'));
  assert.equal(vid.icon, undefined);
});

test('the OUTBOX serves the attachment too, not only the delivered Create', async () => {
  // Root of the broken iPhone player (Robins schermafdrukken, 30-7): the
  // outbox SELECT did not include c2s_attachments, so a note pulled via the
  // outbox (backfill, boiert.eu) had NO Video attachment and readers fell
  // back to the content tag with its relative, dead src. The delivered copy
  // was fine, which is why one device worked and the other did not. This
  // locks the outbox contract: the same narrow SELECT, through buildNote,
  // must carry the attachment.
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note', content: '<p>buiten</p>',
      to: ['https://test.example/ap/users/kid/followers'],
      cc: ['https://www.w3.org/ns/activitystreams#Public'],
      attachment: [{ type: 'Video', url: '/media/reply-media/buiten.mp4', mediaType: 'video/mp4' }],
    },
  });
  const row = db.prepare(
    `SELECT id, slug, title, content, cover_image_url, cover_video_url, nsfw, content_warning, c2s_attachments, published_at, created_at
     FROM posts WHERE id = ?`).get(r.id);
  const note = AP.buildNote('https://test.example', site, row);
  const vid = (note.attachment || []).find((a) => a.url.endsWith('buiten.mp4'));
  assert.ok(vid, 'the outbox-shaped row still yields the Video attachment');
  assert.equal(vid.type, 'Video');
  assert.ok(!/<video\b/i.test(note.content), 'and the content stays clean');
});

test('a media-only post is a post, not an empty-note error', async () => {
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note', content: '',
      to: ['https://test.example/ap/users/kid/followers'],
      attachment: [{ type: 'Image', url: '/media/reply-media/alleen.jpg', mediaType: 'image/png' }],
    },
  });
  assert.equal(r.status, 201, 'a picture can be the whole message');
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
  assert.equal(post.cover_image_url, null, 'no cover: the tile reads the photo from the content');
});
