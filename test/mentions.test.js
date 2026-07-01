// Inline @mentions in posts — buildNote turns already-linked @user@host mentions into AS2
// Mention tags and addresses the mentioned actor in cc (so Mastodon notifies them). The
// WebFinger resolution/linking happens at delivery time; here we cover the sync build step.
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

// A post whose content already carries a resolved mention link (as deliverCreate produces).
const linked = '<p>hi <a href="https://mastodon.social/@bob" class="u-url mention" data-actor="https://mastodon.social/users/bob">@bob@mastodon.social</a></p>';
const post = { id: 'm1', slug: 'x', title: '', content: linked, tags: '[]', created_at: '2026-01-01T00:00:00Z' };

test('a mention becomes an AS2 Mention tag with the actor URI as href', () => {
  const note = AP.buildNote(BASE, site, post);
  const m = note.tag.find((t) => t.type === 'Mention');
  assert.ok(m, 'note.tag has a Mention');
  assert.equal(m.href, 'https://mastodon.social/users/bob');
  assert.equal(m.name, '@bob@mastodon.social');
});

test('the mentioned actor is addressed in cc', () => {
  const note = AP.buildNote(BASE, site, post);
  assert.ok(note.cc.includes('https://mastodon.social/users/bob'), 'mentioned actor in cc');
  assert.ok(note.cc.includes(`${BASE}/ap/users/demo/followers`), 'followers still in cc');
});

test('a post without mentions has no Mention tag and an unchanged cc', () => {
  const plain = { id: 'm2', slug: 'y', title: '', content: '<p>just text</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z' };
  const note = AP.buildNote(BASE, site, plain);
  assert.equal(note.tag.filter((t) => t.type === 'Mention').length, 0);
  assert.deepEqual(note.cc, [`${BASE}/ap/users/demo/followers`]);
});
