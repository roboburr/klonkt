// Inbound mentions — a remote note whose Mention tag targets one of our actors becomes a
// notification, even when it isn't a reply to our content. localMentionSlugs is the detection
// core: only OUR base counts, the slug must exist, deduped. In-memory SQLite. Run: npm test
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

test('a Mention tag with our actor href resolves to the site slug', () => {
  const tags = [
    { type: 'Mention', href: `${BASE}/ap/users/demo`, name: '@demo@test.example' },
    { type: 'Hashtag', href: `${BASE}/tag/x`, name: '#x' },
  ];
  assert.deepEqual(AP.localMentionSlugs(tags, BASE), ['demo']);
});

test('a remote host with the same /ap/users path is NOT ours', () => {
  const tags = [{ type: 'Mention', href: 'https://other.example/ap/users/demo', name: '@demo@other.example' }];
  assert.deepEqual(AP.localMentionSlugs(tags, BASE), []);
});

test('a mention of a non-existent slug is ignored; duplicates dedupe', () => {
  const tags = [
    { type: 'Mention', href: `${BASE}/ap/users/ghost`, name: '@ghost' },
    { type: 'Mention', href: `${BASE}/ap/users/demo`, name: '@demo' },
    { type: 'Mention', href: `${BASE}/ap/users/demo`, name: '@demo' },
  ];
  assert.deepEqual(AP.localMentionSlugs(tags, BASE), ['demo']);
});

test('a stored mention shows up in the notifications', () => {
  db.prepare('INSERT OR IGNORE INTO ap_mentions (slug, object_uri, note_url, actor_uri, actor_name, actor_handle, content) VALUES (?,?,?,?,?,?,?)')
    .run('demo', 'https://m.example/notes/1', 'https://m.example/@a/1', 'https://m.example/users/a', 'Anna', '@a@m.example', '<p>hi @demo</p>');
  const items = AP.getNotifications('demo', 20);
  const m = items.find((n) => n.type === 'mention');
  assert.ok(m, 'mention notification present');
  assert.equal(m.handle, '@a@m.example');
  assert.equal(m.note_url, 'https://m.example/@a/1');
});
