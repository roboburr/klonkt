// Load-more pagination: getTimeline honours limit + offset so the News feed can
// page in blocks of 72 without overlap. In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

// Seed 150 timeline rows with strictly decreasing published times (newest first).
const ins = db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, content, published, created_at)
  VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
for (let i = 0; i < 150; i++) {
  const n = String(i).padStart(3, '0');
  // higher i = older, so order DESC by published yields 000,001,... first
  const pub = `2026-01-01T00:00:00Z`.replace('00:00:00', `${String(23 - Math.floor(i / 60)).padStart(2, '0')}:${String(59 - (i % 60)).padStart(2, '0')}:00`);
  ins.run('n' + n, 'me', 'https://r.test/u/a', 'A', '<p>' + n + '</p>', pub);
}

test('getTimeline pages with limit + offset, no overlap', () => {
  const page1 = AP.getTimeline('me', 72, 0);
  const page2 = AP.getTimeline('me', 72, 72);
  assert.equal(page1.length, 72, 'first page is full');
  assert.equal(page2.length, 72, 'second page is full');
  const ids1 = new Set(page1.map((r) => r.id));
  const overlap = page2.filter((r) => ids1.has(r.id));
  assert.equal(overlap.length, 0, 'pages do not overlap');
});

test('probe of PAGE+1 reveals whether more remain', () => {
  // 150 rows: at offset 0 a probe of 73 returns 73 (more), at offset 144 it returns 6 (done).
  assert.equal(AP.getTimeline('me', 73, 0).length, 73);
  assert.equal(AP.getTimeline('me', 73, 144).length, 6);
});

test('offset past the end returns empty', () => {
  assert.equal(AP.getTimeline('me', 72, 300).length, 0);
});

// getMessages pages the merged stream by offset (recompute-top-down + slice).
const fins = db.prepare('INSERT OR IGNORE INTO ap_followers (slug, actor_uri, created_at) VALUES (?,?,?)');
for (let i = 0; i < 150; i++) {
  const n = String(i).padStart(3, '0');
  const hh = String(23 - Math.floor(i / 60)).padStart(2, '0');
  const mm = String(59 - (i % 60)).padStart(2, '0');
  fins.run('me', 'https://r.test/u/f' + n, `2026-02-01 ${hh}:${mm}:00`);
}

test('getMessages pages the stream by offset without overlap', () => {
  const p1 = AP.getMessages('me', 72, 0);
  const p2 = AP.getMessages('me', 72, 72);
  assert.equal(p1.length, 72);
  assert.equal(p2.length, 72);
  const k = (m) => m.type + '|' + (m.url || m.handle || m.outboxId || '');
  const set1 = new Set(p1.map(k));
  assert.equal(p2.filter((m) => set1.has(k(m))).length, 0, 'no overlap between pages');
});

test('getMessages probe of PAGE+1 signals the last page', () => {
  assert.equal(AP.getMessages('me', 73, 0).length, 73);      // more remain
  assert.equal(AP.getMessages('me', 73, 144).length, 6);     // 150 follows → 6 left
});
