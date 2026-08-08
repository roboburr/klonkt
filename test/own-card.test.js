// De kaart op je EIGEN post (shaer-k3f): een URL in wat je publiceert wordt
// een quote- of embed-snapshot, langs dezelfde pijplijn als een binnenkomende
// post -- en de composer-preview loopt door diezelfde pijplijn, zodat de
// preview nooit iets belooft dat de post niet waarmaakt.
//
// In-memory SQLite, gestubde fetch op TEST-NET-3. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'schrijver', 'Schrijver', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');

const EXTERN = 'https://203.0.113.60/artikel';
const APNOTE = 'https://203.0.113.61/notes/toot-1';
const APAUTEUR = 'https://203.0.113.61/users/schrijfster';

const OG_PAGINA = `<!doctype html><html><head>
  <meta property="og:title" content="Een mooi artikel">
  <meta property="og:image" content="https://203.0.113.60/plaatje.jpg">
</head><body>tekst</body></html>`;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const accepts = String((opts.headers && (opts.headers.Accept || opts.headers.accept)) || '');
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/activity+json' } });
  const html = (h) => new Response(h, { status: 200, headers: { 'content-type': 'text/html' } });
  if (u === EXTERN) return html(OG_PAGINA);   // geen AP, wel OpenGraph
  if (u === APNOTE) {
    // Een echte fediverse-note: op de AP-vraag AP-json, anders een kale pagina.
    if (accepts.includes('activity+json')) return json({ id: APNOTE, type: 'Note', attributedTo: APAUTEUR, content: '<p>de toot</p>', published: '2026-08-01T10:00:00Z' });
    return html('<html><body>toot</body></html>');
  }
  if (u === APAUTEUR) return json({ id: APAUTEUR, type: 'Person', preferredUsername: 'schrijfster', name: 'Schrijfster', inbox: `${APAUTEUR}/inbox` });
  return new Response('not found', { status: 404 });
};

test('een externe link in een eigen post wordt een embed-snapshot op de post', async () => {
  db.prepare("INSERT INTO posts (id, site_id, author_id, slug, title, content, status) VALUES ('p1','s1','u1','p1','', ?, 'published')")
    .run(`<p>Kijk: <a href="${EXTERN}">${EXTERN}</a></p>`);
  const post = db.prepare("SELECT * FROM posts WHERE id = 'p1'").get();
  await AP.deliverCreate(site, post);
  const rij = db.prepare("SELECT quote_json, embed_json FROM posts WHERE id = 'p1'").get();
  assert.ok(rij.embed_json, 'embed-snapshot opgeslagen');
  const kaart = JSON.parse(rij.embed_json);
  assert.equal(kaart.title, 'Een mooi artikel');
  assert.ok(!rij.quote_json, 'geen quote: het is geen fediverse-object');
});

test('een fediverse-link wordt een quote-snapshot, geen embed', async () => {
  db.prepare("INSERT INTO posts (id, site_id, author_id, slug, title, content, status) VALUES ('p2','s1','u1','p2','', ?, 'published')")
    .run(`<p>Dit! <a href="${APNOTE}">${APNOTE}</a></p>`);
  const post = db.prepare("SELECT * FROM posts WHERE id = 'p2'").get();
  await AP.deliverCreate(site, post);
  const rij = db.prepare("SELECT quote_uri, quote_json, embed_json FROM posts WHERE id = 'p2'").get();
  assert.equal(rij.quote_uri, APNOTE);
  assert.ok(rij.quote_json, 'quote-snapshot opgeslagen');
  const kaart = JSON.parse(rij.quote_json);
  assert.ok(kaart.content.includes('de toot'));
  assert.equal(kaart.author.name, 'Schrijfster');
  assert.ok(!rij.embed_json, 'geen embed naast de quote');
});

test('previewCard geeft voor dezelfde twee links dezelfde twee kaarten', async () => {
  const extern = await AP.previewCard(EXTERN);
  assert.ok(extern.embedJson, 'externe link -> embed');
  assert.equal(JSON.parse(extern.embedJson).title, 'Een mooi artikel');
  assert.ok(!extern.quoteJson);

  const ap = await AP.previewCard(APNOTE);
  assert.ok(ap.quoteJson, 'fediverse-link -> quote');
  assert.equal(JSON.parse(ap.quoteJson).author.handle, '@schrijfster@203.0.113.61');
  assert.ok(!ap.embedJson);

  // Rommel is geen kaart en geen fout.
  assert.deepEqual(await AP.previewCard('geen url'), {});
});
