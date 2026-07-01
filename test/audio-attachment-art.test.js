// Cover art on federated audio — a fedi_open track's Audio attachment carries the track
// cover (else the post cover) as an AS2 `icon`, so Mastodon's native audio player can show
// artwork instead of a blank tile. In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'demo', 'Demo', 'u1', 1);
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
site.primary_slug = 'demo';

db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
  .run('m1', 's1', 'song.mp3', 'audio/mpeg', 1000, '/x/song.mp3');
db.prepare('INSERT INTO audio_tracks (id, site_id, title, media_id, cover_url, fedi_open) VALUES (?,?,?,?,?,?)')
  .run('t1', 's1', 'Song One', 'm1', '/media/art.webp', 1);
db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
  .run('m2', 's1', 'bare.mp3', 'audio/mpeg', 1000, '/x/bare.mp3');
db.prepare('INSERT INTO audio_tracks (id, site_id, title, media_id, fedi_open) VALUES (?,?,?,?,?)')
  .run('t2', 's1', 'Bare Track', 'm2', 1);

test('a fedi_open track carries its cover as the Audio attachment icon', () => {
  const post = { id: 'p1', slug: 'x', title: '', content: '<p>[[track:t1]]</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z' };
  const att = (AP.buildNote(BASE, site, post).attachment || []).find((a) => a.type === 'Audio');
  assert.ok(att, 'Audio attachment present');
  assert.ok(att.icon, 'icon present');
  assert.equal(att.icon.type, 'Image');
  assert.equal(att.icon.url, `${BASE}/media/art.webp`);
});

test('a coverless track falls back to the post cover', () => {
  const post = { id: 'p2', slug: 'y', title: '', content: '<p>[[track:t2]]</p>', tags: '[]', cover_image_url: '/media/post.webp', created_at: '2026-01-01T00:00:00Z' };
  const att = (AP.buildNote(BASE, site, post).attachment || []).find((a) => a.type === 'Audio');
  assert.equal(att.icon.url, `${BASE}/media/post.webp`);
});

test('no track cover and no post cover → no icon', () => {
  const post = { id: 'p3', slug: 'z', title: '', content: '<p>[[track:t2]]</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z' };
  const att = (AP.buildNote(BASE, site, post).attachment || []).find((a) => a.type === 'Audio');
  assert.ok(!('icon' in att));
});
