// C2S inbox read (owner only): the route maps ap_timeline rows to Create(Note)
// items; here we cover the data path (fields the mapping relies on). The
// bearer gate itself follows the followers-route pattern (verified live).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, content, url, published, nsfw, cw, created_at)
  VALUES ('https://r.test/n/1','me','https://r.test/u/a','A','<p>hoi</p>','https://r.test/@a/1','2026-07-01T10:00:00Z',1,'let op',CURRENT_TIMESTAMP)`).run();

test('timeline rows carry the fields the inbox mapping needs', () => {
  const [t] = AP.getTimeline('me', 10);
  assert.equal(t.id, 'https://r.test/n/1');
  assert.equal(t.author_uri, 'https://r.test/u/a');
  assert.equal(t.content, '<p>hoi</p>');
  assert.equal(t.url, 'https://r.test/@a/1');
  assert.equal(t.nsfw, 1);
  assert.equal(t.cw, 'let op');
  assert.ok(t.published);
});
