// Hashtags in een post uit Shaer worden tags (shaer-m5s6), en de tagpagina
// toont alleen openbare posts, gevonden zonder onderscheid in schrijfwijze.
//
// In-memory SQLite. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const core = await import('../src/services/ap-core.js');
const { findTaggedPosts } = await import('../src/routes/tags.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
const token = 'test-token-tags-' + 'a'.repeat(24);
db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
  .run(crypto.createHash('sha256').update(token).digest('base64url'), 'shaer', 'u1', 'ik', 'c2s');

const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const LOKAAL = `http://127.0.0.1:${server.address().port}`;
server.unref();
after(() => server.close());

const post = async (note) => {
  const r = await fetch(`${LOKAAL}/ap/users/ik/outbox`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/activity+json' },
    body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Note', ...note }),
  });
  assert.ok(r.status < 300, `outbox gaf ${r.status}`);
  const { id } = await r.json();
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
};
const tagsVan = (p) => JSON.parse(p.tags || '[]');
const gevonden = (tag) => findTaggedPosts('s1', tag).map((p) => p.id);

test('hashtagsIn vindt de tags zoals ze geschreven zijn, en niet in een url', () => {
  assert.deepEqual(core.hashtagsIn('Koffie #ochtend en #LiveMusic (#ochtend) zie https://x.test/a#frag'), ['ochtend', 'LiveMusic']);
  assert.deepEqual(core.hashtagsIn('geen tags hier'), []);
});

test('tagKey: hoofdletters, spaties en het hekje maken niet uit', () => {
  for (const t of ['Live Music', '#LiveMusic', 'livemusic', 'live_music']) assert.equal(core.tagKey(t), 'livemusic', t);
  assert.equal(core.tagKey('#'), '');
});

test('een post uit Shaer bewaart zijn hashtags als tags', async () => {
  const p = await post({ content: '<p>Goedemorgen #Koffie en #ochtend #koffie</p>', to: [PUBLIC] });
  assert.deepEqual(tagsVan(p), ['Koffie', 'ochtend'], 'ontdubbeld op de sleutel, zoals geschreven');
});

test('ook een Hashtag die de client zelf meestuurt', async () => {
  const p = await post({ content: '<p>zonder hekje in de tekst</p>', to: [PUBLIC], tag: [{ type: 'Hashtag', name: '#Extra' }] });
  assert.deepEqual(tagsVan(p), ['Extra']);
});

test('een post zonder hashtags houdt een lege tags-kolom', async () => {
  const p = await post({ content: '<p>gewoon</p>', to: [PUBLIC] });
  assert.equal(p.tags, null);
});

test('de tagpagina vindt een Shaer-post onder zijn tag, in elke schrijfwijze', async () => {
  const p = await post({ content: '<p>#Zondag</p>', to: [PUBLIC] });
  for (const t of ['zondag', 'Zondag', '#zondag']) assert.ok(gevonden(t).includes(p.id), t);
});

test('en een editor-post met "Live Music" via de kleingeschreven link', () => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, tags, published_at)
              VALUES ('e1','s1','e1','u1','Show','<p>x</p>','published','post',?, '2026-11-01T00:00:00Z')`)
    .run(JSON.stringify(['Live Music']));
  assert.ok(gevonden('livemusic').includes('e1'));
  assert.ok(gevonden('LiveMusic').includes('e1'));
});

test('alleen openbaar: een vriendenpost of een post voor alleen de mensen erin staat er niet', async () => {
  const vrienden = await post({ content: '<p>#geheim</p>', to: ['https://klonkt.test/ap/users/ik/followers'] });
  assert.deepEqual(tagsVan(vrienden), ['geheim'], 'de tag staat wel bij de post');
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, tags, fan_only, ap_visibility, published_at)
              VALUES ('d1','s1','d1','u1','','<p>x</p>','published','post',?, 1, 'direct', '2026-11-01T00:00:00Z')`)
    .run(JSON.stringify(['geheim']));
  assert.deepEqual(gevonden('geheim'), []);
});

test('een concept staat er ook niet', () => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, tags)
              VALUES ('c1','s1','c1','u1','','<p>x</p>','draft','post',?)`).run(JSON.stringify(['concept']));
  assert.deepEqual(gevonden('concept'), []);
});

// ── Eenmalig aanvullen van wat er al stond ──────────────────────────
const B = await import('../src/services/hashtag-backfill.js');

test('aanvullen: wat ontbrak komt erachter, wat er stond blijft vooraan', () => {
  assert.deepEqual(B.aangevuld(null, '<p>Oud #Koffie bericht</p>'), ['Koffie']);
  assert.deepEqual(B.aangevuld(JSON.stringify(['Live Music']), '<p>#livemusic en #Extra</p>'), ['Live Music', 'Extra']);
  assert.equal(B.aangevuld(JSON.stringify(['koffie']), '<p>#Koffie</p>'), null, 'niets erbij, niets veranderd');
  assert.deepEqual(B.aangevuld('rock, pop', '<p>#jazz</p>'), ['rock', 'pop', 'jazz'], 'ook een oude kommalijst');
});

test('de migratie vult oude posts één keer aan, en de tagpagina vindt ze', () => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, published_at, updated_at)
              VALUES ('oud1','s1','oud1','u1','','<p>van vorige week #Markt</p>','published','post','2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`).run();
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, tags, published_at)
              VALUES ('oud2','s1','oud2','u1','','<p>#markt en #Fiets</p>','published','post',?, '2026-11-03T00:00:00Z')`).run(JSON.stringify(['Fiets']));
  const r = B.migrateHashtagTags();
  assert.ok(r.aangevuld >= 2);
  assert.deepEqual(JSON.parse(db.prepare("SELECT tags FROM posts WHERE id = 'oud1'").get().tags), ['Markt']);
  assert.deepEqual(JSON.parse(db.prepare("SELECT tags FROM posts WHERE id = 'oud2'").get().tags), ['Fiets', 'markt']);
  assert.equal(db.prepare("SELECT updated_at FROM posts WHERE id = 'oud1'").get().updated_at, '2026-11-02T00:00:00Z', 'de post zelf veranderde niet');
  assert.deepEqual(gevonden('markt').sort(), ['oud1', 'oud2']);
  assert.equal(B.migrateHashtagTags().overgeslagen, true, 'de tweede keer niet');
});
