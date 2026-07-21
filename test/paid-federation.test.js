// Paid posts slice 2 (klonkt-demo-aki): a paid post federates a PUBLIC teaser +
// link, never its full content, so nothing leaks past the paywall.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const base = 'https://test.example';
const site = { slug: 'me', primary_slug: 'me' };
const SECRET = 'THE-SECRET-BODY-that-must-not-federate';

test('a paid post federates a teaser + supporters link, not the full content', () => {
  const post = {
    id: 'p1', slug: 'geheim', title: 'Geheim', tags: '[]',
    content: `<p>intro zin die de teaser wordt.</p><p>${SECRET}</p>`,
    excerpt: '', paid: 1, created_at: '2026-01-01T00:00:00Z', published_at: '2026-01-01T00:00:00Z',
  };
  const note = AP.buildNote(base, site, post);
  assert.equal(note.type, 'Note');
  assert.ok(note.content.includes('Lees de volledige post'), 'has the supporters link');
  assert.ok(note.content.includes(`${base}/geheim`), 'links back to the post');
  assert.ok(!note.content.includes(SECRET), 'the secret body must NOT federate');
  assert.deepEqual(note.to, ['https://www.w3.org/ns/activitystreams#Public'], 'teaser is public');
  assert.ok(!('attachment' in note) || !note.attachment || note.attachment.length === 0, 'no media leaks');
});

test('the excerpt is used as the teaser when present', () => {
  const post = {
    id: 'p2', slug: 'x', title: 'X', tags: '[]',
    content: `<p>${SECRET}</p>`, excerpt: 'Netjes teasertje', paid: 1,
    created_at: '2026-01-01T00:00:00Z',
  };
  const note = AP.buildNote(base, site, post);
  assert.ok(note.content.includes('Netjes teasertje'));
  assert.ok(!note.content.includes(SECRET));
});

test('a normal (non-paid) post still federates its full content', () => {
  const post = {
    id: 'p3', slug: 'open', title: 'Open', tags: '[]',
    content: `<p>${SECRET}</p>`, paid: 0, created_at: '2026-01-01T00:00:00Z',
  };
  const note = AP.buildNote(base, site, post);
  assert.ok(note.content.includes(SECRET), 'non-paid content federates as before');
});
