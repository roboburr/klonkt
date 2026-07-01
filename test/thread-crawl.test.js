// Remote thread crawl — the stale-while-revalidate guard. The BFS itself is network-bound
// (verified live), so here we only cover that the entry point exists, is safe with no cached
// replies (no seeds → no crawl), and is TTL-gated. In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

test('maybeCrawlThread is exported and safe with no cached replies', () => {
  assert.equal(typeof AP.maybeCrawlThread, 'function');
  // No ap_interactions rows for this post → the crawl finds no seeds and does nothing.
  AP.maybeCrawlThread('no-replies-post');
  assert.ok(true, 'did not throw');
});

test('a second call within the TTL is gated (timestamp recorded)', () => {
  AP.maybeCrawlThread('ttl-post');
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('thread_crawl:ttl-post');
  assert.ok(row && Number(row.value) > 0, 'crawl timestamp recorded');
  // Immediately calling again must not reset/refire (still gated by the fresh timestamp).
  const before = row.value;
  AP.maybeCrawlThread('ttl-post');
  const after = db.prepare('SELECT value FROM app_settings WHERE key = ?').get('thread_crawl:ttl-post').value;
  assert.equal(after, before, 'timestamp unchanged within TTL');
});
