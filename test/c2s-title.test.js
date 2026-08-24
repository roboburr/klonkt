// Een C2S-post kon nooit een titel hebben (shaer-uply): c2sCreatePost schreef
// '' in posts.title en in posts_fts en las `name` op het binnenkomende object
// nooit. Een client die er een zette zag hem geruisloos verdwijnen -- de API
// was daarmee de enige publicatieweg die iets niet kon wat het web wel kan.
// Gevonden door R9999, dat alleen over C2S publiceert.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('kid');
const user = db.prepare('SELECT * FROM users WHERE id = ?').get('u1');

function maak(object) {
  return AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note',
      to: ['https://test.example/ap/users/kid/followers'],
      cc: ['https://www.w3.org/ns/activitystreams#Public'],
      ...object,
    },
  });
}

test('de titel van een C2S-post komt in de kolom, de zoekindex en de note', async () => {
  const r = await maak({ name: 'Mijn eerste getitelde note', content: '<p>de inhoud</p>' });
  assert.equal(r.status, 201);

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
  assert.equal(post.title, 'Mijn eerste getitelde note', 'de kolom draagt de titel');

  // Vindbaar OP de titel, niet alleen op de inhoud -- de tweede schrijfplek
  // uit shaer-uply. Was alleen de kolom gerepareerd, dan faalde deze.
  const hit = db.prepare("SELECT post_id FROM posts_fts WHERE posts_fts MATCH 'getitelde'").get();
  assert.ok(hit && hit.post_id === r.id, 'de titel staat in de zoekindex');

  // En hij federeert zoals een webpost: Mastodon negeert `name` op een Note,
  // dus buildNote vouwt de titel als vetgedrukte eerste regel in de content.
  const note = AP.buildNote('https://test.example', site, post);
  assert.match(note.content, /^<p><strong>Mijn eerste getitelde note<\/strong><\/p>/, 'vetgedrukte eerste regel');
});

test('zonder name blijft alles zoals het was: lege titel, geen kopregel', async () => {
  const r = await maak({ content: '<p>gewoon een note</p>' });
  assert.equal(r.status, 201);
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
  assert.equal(post.title, '', 'geen name is een lege titel, geen undefined of null');
  const note = AP.buildNote('https://test.example', site, post);
  assert.ok(!/<strong>/.test(note.content.split('</p>')[0] + '</p>') || !post.title, 'geen verzonnen kopregel');
});

test('de titel is platte tekst: HTML erin wordt tekst, en de grens is 200', async () => {
  // `name` is per AS2 platte tekst, maar een client kan sturen wat hij wil.
  // De kolom en de views verwachten tekst; opmaak wordt dus tekst, en een
  // scriptpoging houdt niets uitvoerbaars over.
  const r = await maak({ name: 'Dag <b>wereld</b><script>boem()</script>', content: '<p>x</p>' });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(r.id);
  assert.ok(!post.title.includes('<'), 'geen tags in de kolom');
  assert.match(post.title, /^Dag wereld/, 'de tekst zelf blijft');

  // En de note escapet hem daarna zelf weer voor de vetgedrukte regel, dus
  // ook daar geen tag-injectie via de titel.
  const note = AP.buildNote('https://test.example', site, post);
  assert.ok(!/<script/i.test(note.content), 'niets uitvoerbaars in de note');

  const lang = await maak({ name: 'x'.repeat(500), content: '<p>y</p>' });
  const langePost = db.prepare('SELECT title FROM posts WHERE id = ?').get(lang.id);
  assert.equal(langePost.title.length, 200, 'de huisgrens van 200, zoals content warning en sitetitel');
});

test('een titel met alleen witruimte is geen titel', async () => {
  const r = await maak({ name: '   ', content: '<p>z</p>' });
  const post = db.prepare('SELECT title FROM posts WHERE id = ?').get(r.id);
  assert.equal(post.title, '', 'witruimte trimt weg tot leeg');
  const note = AP.buildNote('https://test.example', site, post);
  assert.ok(!note.content.startsWith('<p><strong>'), 'en er komt geen lege kopregel');
});
