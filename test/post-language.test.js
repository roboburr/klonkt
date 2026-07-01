// Content language — a post's language federates as an AS2 contentMap (Mastodon's language
// filter + translate button read the map's key). In-memory SQLite. Run: npm test
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

test('a post language federates as a contentMap keyed by the language', () => {
  const post = { id: 'l1', slug: 'x', title: '', content: '<p>hallo</p>', tags: '[]', language: 'nl', created_at: '2026-01-01T00:00:00Z' };
  const note = AP.buildNote(BASE, site, post);
  assert.ok(note.contentMap, 'contentMap present');
  assert.deepEqual(Object.keys(note.contentMap), ['nl']);
  assert.equal(note.contentMap.nl, note.content, 'contentMap value mirrors content');
  assert.ok(note.content, 'plain content still emitted alongside');
});

test('no language → no contentMap', () => {
  const post = { id: 'l2', slug: 'y', title: '', content: '<p>hi</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z' };
  assert.ok(!('contentMap' in AP.buildNote(BASE, site, post)));
});

test('an invalid language code is ignored', () => {
  const post = { id: 'l3', slug: 'z', title: '', content: '<p>hi</p>', tags: '[]', language: 'not-a-lang!!', created_at: '2026-01-01T00:00:00Z' };
  assert.ok(!('contentMap' in AP.buildNote(BASE, site, post)));
});
