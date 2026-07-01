// Auto-linking bare URLs — a plain http(s) URL in a post's federated copy becomes a
// clickable link; already-linked URLs and attribute values are left alone; trailing
// sentence punctuation stays outside the link. In-memory SQLite. Run: npm test
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

const note = (content, extra = {}) => AP.buildNote(BASE, site, {
  id: 'u' + Math.abs(content.length * 7919 % 100000), slug: 'x', title: '', content, tags: '[]',
  created_at: '2026-01-01T00:00:00Z', ...extra,
});

test('a bare URL becomes a link; trailing punctuation stays outside', () => {
  const n = note('<p>check https://example.com/x?a=1&amp;b=2, ok</p>');
  assert.match(n.content, /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2" rel="nofollow noopener" target="_blank">https:\/\/example\.com\/x\?a=1&amp;b=2<\/a>,/);
});

test('a URL with a fragment does not get hashtag-ified', () => {
  const n = note('<p>see https://example.com/page#section</p>');
  assert.match(n.content, /<a href="https:\/\/example\.com\/page#section"/);
  assert.ok(!/class="mention hashtag"[^>]*>#section/.test(n.content), 'no hashtag link out of the fragment');
});

test('an already-linked URL is not wrapped twice', () => {
  const n = note('<p><a href="https://example.com/">https://example.com/</a></p>');
  assert.equal((n.content.match(/<a /g) || []).length, 1);
});

test('a URL inside parentheses links, closing paren stays outside', () => {
  const n = note('<p>site (https://example.com/a) hier</p>');
  assert.match(n.content, /\(<a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\)/);
});

test('a hashtag inside parentheses still links; quoted attribute values never match', () => {
  const n = note('<p>leuk (#jazz) toch</p>');
  assert.match(n.content, /\(<a [^>]*class="mention hashtag"[^>]*>#jazz<\/a>\)/);
  // A quote precedes attribute values — the prefix class must NOT include quotes.
  const n2 = note('<p>plaatje <a href="https://x.example/#frag">link</a></p>');
  assert.equal((n2.content.match(/<a /g) || []).length, 1, 'href value untouched');
});

test('attribute values are untouched, standalone URLs still link (image stripped from content)', () => {
  const n = note('<p><img src="https://cdn.example.com/pic.png" alt=""> and https://example.org</p>');
  // <img> is stripped from federated content (travels as attachment) — no anchor made for its src.
  assert.ok(!n.content.includes('cdn.example.com'), 'img src not present in content');
  assert.match(n.content, /<a href="https:\/\/example\.org"/);
});
