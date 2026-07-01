// Media alt text — the cover's alt and inline <img alt="…"> federate as the AS2 attachment
// `name` (accessibility). In-memory SQLite. Run: npm test
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

test('the cover alt federates as the attachment name', () => {
  const post = { id: 'a1', slug: 'x', title: '', content: '<p>hi</p>', tags: '[]', cover_image_url: '/media/c.webp', cover_alt: 'A red bicycle', created_at: '2026-01-01T00:00:00Z' };
  const note = AP.buildNote(BASE, site, post);
  const att = (note.attachment || []).find((a) => a.url.endsWith('c.webp'));
  assert.ok(att, 'cover attachment present');
  assert.equal(att.name, 'A red bicycle');
});

test('an inline <img alt="…"> federates its alt as the attachment name', () => {
  const post = { id: 'a2', slug: 'y', title: '', content: '<p><img src="/media/cat.png" alt="a sleeping cat"></p>', tags: '[]', created_at: '2026-01-01T00:00:00Z' };
  const note = AP.buildNote(BASE, site, post);
  const att = (note.attachment || []).find((a) => a.url.endsWith('cat.png'));
  assert.ok(att, 'inline image attachment present');
  assert.equal(att.name, 'a sleeping cat');
});

test('no alt → no name field (stays valid AS2)', () => {
  const post = { id: 'a3', slug: 'z', title: '', content: '<p>x</p>', tags: '[]', cover_image_url: '/media/n.webp', created_at: '2026-01-01T00:00:00Z' };
  const note = AP.buildNote(BASE, site, post);
  const att = (note.attachment || []).find((a) => a.url.endsWith('n.webp'));
  assert.ok(att, 'cover attachment present');
  assert.ok(!('name' in att), 'no name when no alt');
});
