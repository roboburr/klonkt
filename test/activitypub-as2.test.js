// AS2 / JSON-LD validity guard.
//
// Every property key and `type` value our ActivityPub objects emit MUST be either an AS2-core
// (or security/v1) term OR declared in the federation @context (AP_CONTEXT). A new feature that
// emits an undeclared term fails this test → declare it in AP_CONTEXT (extensions) or add it to
// the AS2 allowlist below. This keeps Klonkt's output valid AS2/JSON-LD forever — not just
// "Mastodon tolerates it". No extra deps; in-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';

// AS2-core + security/v1 vocabulary Klonkt uses (stable — only extend when AS2/security itself
// adds a term we adopt). JSON-LD keywords included.
const AS2 = new Set([
  '@context', '@id', '@type',
  'id', 'type', 'actor', 'object', 'target', 'to', 'cc',
  'content', 'name', 'summary', 'url', 'href', 'mediaType',
  'published', 'updated', 'attributedTo', 'inReplyTo', 'replies',
  'attachment', 'tag', 'icon', 'image', 'duration',
  'totalItems', 'orderedItems', 'items', 'first', 'last', 'partOf', 'next', 'prev',
  'preferredUsername', 'inbox', 'outbox', 'followers', 'following', 'endpoints', 'sharedInbox',
  'publicKey', 'owner', 'publicKeyPem',
  'Note', 'Person', 'Create', 'Update', 'Delete', 'Tombstone', 'Announce', 'Like', 'Follow',
  'Accept', 'Reject', 'Undo', 'Add', 'Remove', 'Document', 'Image', 'Audio', 'Video',
  'Mention', 'Link', 'Collection', 'OrderedCollection', 'OrderedCollectionPage',
]);

// The extension terms = exactly the keys declared in AP_CONTEXT's term-definition object.
const ctxTerms = new Set();
for (const part of AP.AP_CONTEXT) if (part && typeof part === 'object') for (const k of Object.keys(part)) ctxTerms.add(k);
const allowed = new Set([...AS2, ...ctxTerms]);

// Collect every property key + every `type` string value, recursively.
function collect(obj, keys = new Set()) {
  if (Array.isArray(obj)) { for (const x of obj) collect(x, keys); return keys; }
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      keys.add(k);
      if (k === 'type' && typeof v === 'string') keys.add(v);
      collect(v, keys);
    }
  }
  return keys;
}
function assertValid(obj, label) {
  const undeclared = [...collect(obj)].filter((k) => !allowed.has(k));
  assert.deepEqual(undeclared, [],
    `${label}: undeclared AS2/JSON-LD term(s) — declare in AP_CONTEXT (extension) or the AS2 allowlist: ${undeclared.join(', ')}`);
}

// Seed one site that exercises the extension-heavy actor fields (profile links → PropertyValue,
// photo → icon, primary → featured).
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary, profile_links, profile_photo) VALUES (?,?,?,?,?,?,?)')
  .run('s1', 'demo', 'Demo', 'u1', 1, JSON.stringify([{ platform: 'website', url: 'https://x.test' }]), '/media/x.png');
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
site.primary_slug = 'demo';

// Kitchen-sink note: nsfw (→ sensitive + summary), a hashtag (→ Hashtag), a cover (→ attachment).
const post = {
  id: 'p1', slug: 'hello', title: 'Hi', content: '<p>hello #music</p>',
  nsfw: 1, content_warning: 'cw', tags: JSON.stringify(['mood']),
  cover_image_url: '/media/c.webp',
  published_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
};

test('actor is valid AS2 (every term declared)', () => assertValid(AP.buildActor(BASE, site), 'actor'));
test('create+note is valid AS2 (every term declared)', () => assertValid(AP.buildCreate(BASE, site, post), 'create/note'));
test('outbox/followers/featured collections are valid AS2', () => {
  assertValid(AP.buildOutbox(BASE, site, [post]), 'outbox');
  assertValid(AP.buildFollowers(BASE, site, 3), 'followers');
  assertValid(AP.buildFollowing(BASE, site, 2), 'following');
  assertValid(AP.buildFeatured(BASE, site, [post]), 'featured');
});
test('AP_CONTEXT declares every extension term we rely on', () => {
  for (const t of ['sensitive', 'Hashtag', 'manuallyApprovesFollowers', 'discoverable', 'featured', 'PropertyValue', 'embedUrl'])
    assert.ok(ctxTerms.has(t), `AP_CONTEXT must declare "${t}"`);
});
