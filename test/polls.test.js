// Outbound polls — a hosted poll federates as an AS2 Question and its tally is derived
// from the poll_votes ballots. No extra deps; in-memory SQLite. Run: npm test
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

// A single-choice poll with three options; seed distinct ballots: A×2 (x, z), B×1 (y).
const singlePoll = {
  id: 'p1', slug: 'fav', title: 'Favourite?', content: '<p>Pick one</p>', tags: '[]',
  published_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
  poll_json: JSON.stringify({ multiple: false, options: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], endTime: '2030-01-01T00:00:00Z', closed: false }),
};
const ins = db.prepare('INSERT OR IGNORE INTO poll_votes (post_id, actor_uri, choice) VALUES (?,?,?)');
ins.run('p1', 'https://a.test/users/x', 'A');
ins.run('p1', 'https://b.test/users/y', 'B');
ins.run('p1', 'https://c.test/users/z', 'A');

test('a hosted poll federates as an AS2 Question with oneOf + tally', () => {
  const note = AP.buildNote(BASE, site, singlePoll);
  assert.equal(note.type, 'Question');
  assert.ok(Array.isArray(note.oneOf) && !note.anyOf, 'single choice → oneOf, no anyOf');
  assert.equal(note.oneOf.length, 3);
  const byName = Object.fromEntries(note.oneOf.map((o) => [o.name, o.replies.totalItems]));
  assert.equal(byName.A, 2);
  assert.equal(byName.B, 1);
  assert.equal(byName.C, 0);
  assert.equal(note.votersCount, 3, 'three distinct voters');
  assert.ok(note.endTime, 'has an endTime');
  assert.ok(!('attachment' in note), 'no media on a poll (mutually exclusive on Mastodon)');
});

test('a poll KEEPS its cover in note.image (feeds show it; Mastodon ignores it)', () => {
  // An embed/music poll suppresses image attachments (so Mastodon shows the
  // player/embed card) and carries the cover in note.image instead — exactly
  // the case that lost its cover when applyPollToNote deleted image.
  const withCover = {
    ...singlePoll, id: 'p1', slug: 'fav',
    content: '<p>Pick one</p> [[embed:https://www.youtube.com/watch?v=abcdefghijk]]',
    cover_image_url: '/media/post-images/cover.webp', cover_alt: 'Album art',
  };
  const note = AP.buildNote(BASE, site, withCover);
  assert.equal(note.type, 'Question', 'still a Question');
  assert.ok(note.image && note.image.url, 'the cover survives as note.image');
  assert.ok(note.image.url.endsWith('/media/post-images/cover.webp'), 'absolute cover url');
  assert.equal(note.image.name, 'Album art', 'alt text kept');
  assert.ok(!('attachment' in note), 'still no media attachment on a poll');
});

test('votersCount is a declared JSON-LD term (valid AS2)', () => {
  const ctx = new Set();
  for (const part of AP.AP_CONTEXT) if (part && typeof part === 'object') for (const k of Object.keys(part)) ctx.add(k);
  assert.ok(ctx.has('votersCount'), 'AP_CONTEXT must declare votersCount');
});

test('ownPollView computes single-choice percentages against total votes', () => {
  const view = AP.ownPollView(singlePoll);
  assert.equal(view.total, 3);
  assert.equal(view.voters, 3);
  assert.equal(view.multiple, false);
  const a = view.options.find((o) => o.name === 'A');
  assert.equal(a.count, 2);
  assert.equal(a.pct, 67); // round(2/3*100)
});

test('multiple-choice poll → anyOf and percentages against voters', () => {
  const multiPoll = {
    id: 'p2', slug: 'langs', title: 'Which?', content: '<p>Pick any</p>', tags: '[]',
    published_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    poll_json: JSON.stringify({ multiple: true, options: [{ name: 'X' }, { name: 'Y' }], endTime: '2030-01-01T00:00:00Z', closed: false }),
  };
  // One voter picks both options → two ballots, one voter. Each option = 100% of voters.
  ins.run('p2', 'https://a.test/users/x', 'X');
  ins.run('p2', 'https://a.test/users/x', 'Y');
  const note = AP.buildNote(BASE, site, multiPoll);
  assert.ok(Array.isArray(note.anyOf) && !note.oneOf, 'multiple choice → anyOf, no oneOf');
  assert.equal(note.votersCount, 1);
  const view = AP.ownPollView(multiPoll);
  assert.equal(view.voters, 1);
  assert.equal(view.options.find((o) => o.name === 'X').pct, 100);
  assert.equal(view.options.find((o) => o.name === 'Y').pct, 100);
});

test('a poll past its endTime reads as closed', () => {
  const ended = { id: 'p3', poll_json: JSON.stringify({ multiple: false, options: [{ name: 'A' }, { name: 'B' }], endTime: '2000-01-01T00:00:00Z', closed: false }) };
  assert.equal(AP.parseOwnPoll(ended.poll_json).closed, true);
});

test('a post without a poll stays a Note', () => {
  const plain = { id: 'p9', slug: 'x', title: 'x', content: '<p>hi</p>', tags: '[]', created_at: '2026-01-01T00:00:00Z' };
  assert.equal(AP.buildNote(BASE, site, plain).type, 'Note');
  assert.equal(AP.ownPollView(plain), null);
});
