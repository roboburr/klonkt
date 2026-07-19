// C2S owner collections: followers/following are count-only by default, but
// carry the real actor URIs when the account owner asks (klonkt-demo-6kc).
// The route-level bearer gate is verified live; here we cover the builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

const base = 'https://klonkt.test';
const site = { slug: 'me', primary_slug: 'me' };

test('followers/following are count-only when no items are passed', () => {
  const f = AP.buildFollowers(base, site, 7);
  assert.equal(f.type, 'OrderedCollection');
  assert.equal(f.totalItems, 7);
  assert.deepEqual(f.orderedItems, []);

  const g = AP.buildFollowing(base, site, 3);
  assert.equal(g.totalItems, 3);
  assert.deepEqual(g.orderedItems, []);
});

test('the owner view carries the real actor URIs', () => {
  const uris = ['https://a.test/actor', 'https://b.test/actor'];
  const f = AP.buildFollowers(base, site, 999, uris);
  assert.deepEqual(f.orderedItems, uris);
  assert.equal(f.totalItems, 2); // reflects the items, not the passed count

  const g = AP.buildFollowing(base, site, 0, uris);
  assert.deepEqual(g.orderedItems, uris);
  assert.equal(g.totalItems, 2);
});

test('an empty owner list is a valid empty collection, not count-only fallback', () => {
  const f = AP.buildFollowers(base, site, 5, []);
  assert.equal(f.totalItems, 0);
  assert.deepEqual(f.orderedItems, []);
});
