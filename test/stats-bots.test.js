// Statistics count READERS, not servers (Robins vraag, 31-7). Fediverse
// link-preview fetchers (Mastodon's http.rb and friends) hit the human post
// URL when a post gets boosted; without these guards every instance counted
// as a pageview AND a unique visitor.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const Stats = await import('../src/services/StatsService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'r@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'me', 'Me', 'u1');

const pv = () => db.prepare('SELECT COALESCE(SUM(pageviews),0) AS n FROM stat_daily').get().n;
const fakeReq = (headers = {}, ip = '203.0.113.7') => ({ ip, headers, session: {} });

test('a human browser counts', () => {
  const before = pv();
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Mozilla/5.0 (iPhone; like Mac OS X) Safari/605.1' }));
  assert.equal(pv(), before + 1);
});

test('a fediverse preview fetcher does not count', () => {
  const before = pv();
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'http.rb/5.1.1 (Mastodon/4.2.10; +https://koffieengaar.nl/)' }));
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Pleroma 2.6.2; https://p.example <admin@p.example>' }));
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Misskey/2024.10 (https://m.example)' }));
  assert.equal(pv(), before, 'server fetches are not readers');
});

test("a Klonkt's own embed-fetcher does not count on another Klonkt", () => {
  const before = pv();
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Mozilla/5.0 (compatible; Klonkt/1.0; +https://klonkt.com)' }));
  assert.equal(pv(), before);
});

test('a SIGNED request never counts, whatever the UA claims', () => {
  const before = pv();
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Mozilla/5.0 totally-a-browser', signature: 'keyId="x",signature="y"' }));
  assert.equal(pv(), before);
});

test('ActivityPub content-negotiation never counts either', () => {
  const before = pv();
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Mozilla/5.0 totally-a-browser', accept: 'application/activity+json' }));
  Stats.recordPageview('s1', fakeReq({ 'user-agent': 'Mozilla/5.0', accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"' }));
  assert.equal(pv(), before);
});
