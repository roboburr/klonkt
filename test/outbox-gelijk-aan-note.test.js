// De outbox en de losse Note zijn HETZELFDE object (Robin, 30-9).
//
// Aanleiding: de hub vond de hashtags van soundfabrics niet. Haal je een post
// los op (/ap/notes/:id) dan draagt hij `#kawaii`; lees je hem uit de outbox,
// dan niet. Oorzaak: outboxSlice haalde de posts op met een vaste lijst
// kolommen, en die lijst faalt stil -- een vergeten kolom is `undefined`,
// buildNote beslist zonder, en er komt geen foutmelding. `tags` ontbrak, maar
// ook poll_json, quote_uri, quote_actor, cover_alt en language. Het was de
// vierde keer: eerder ging het zo mis met fan_only en met paid.
//
// Deze toets vergelijkt daarom niet een paar velden maar het HELE object. Een
// kolom die er later bijkomt en in de outbox niet meekomt, valt hier meteen op.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

const BASE = 'https://ons.test';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run('s1', 'band', 'De Band', 'u1');
const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();

// Een post die ELK veld gebruikt waar het misging -- en de hashtags staan
// bewust niet in de tekst, precies zoals bij soundfabrics.
db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at,
            tags, poll_json, quote_uri, quote_actor, cover_image_url, cover_alt, language)
            VALUES (?,?,?,?,?,?,'published',?,?,?,?,?,?,?,?)`)
  .run('p1', 's1', 'u1', 'alles', 'Alles', '<p>geen hashtag in deze zin</p>', '2026-09-30T10:00:00Z',
    JSON.stringify(['kawaii', 'leuk']),
    JSON.stringify({ options: [{ name: 'ja' }, { name: 'nee' }], endTime: '2099-01-01T00:00:00Z' }),
    'https://elders.test/notes/1', 'https://elders.test/users/iemand',
    '/media/hoes.jpg', 'Een oranje hoes', 'nl');
// Een gewone post met alleen een omslag: bij een citaat of peiling laat
// buildNote de omslag bewust weg, dus de alt-tekst toetsen we los.
db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at,
            cover_image_url, cover_alt) VALUES (?,?,?,?,?,?,'published',?,?,?)`)
  .run('p2', 's1', 'u1', 'hoes', 'Hoes', '<p>een plaatje</p>', '2026-09-29T10:00:00Z',
    '/media/hoes.jpg', 'Een oranje hoes');
const los = (id) => AP.buildNote(BASE, site, db.prepare('SELECT * FROM posts WHERE id = ?').get(id));

const uitOutbox = (apId) => {
  const { posts, tracks } = AP.outboxSlice('s1', {});
  const ob = AP.buildOutbox(BASE, site, posts, tracks);
  const create = (ob.orderedItems || []).find((a) => a.object && a.object.id === apId);
  return create && create.object;
};

test('de outbox levert hetzelfde object als de losse Note', () => {
  // Zoals /ap/notes/:id hem ophaalt: SELECT *. Voor elke post, niet een.
  for (const id of ['p1', 'p2']) {
    const note = los(id);
    const uitDeOutbox = uitOutbox(note.id);
    assert.ok(uitDeOutbox, `${id} staat in de outbox`);
    assert.deepEqual(uitDeOutbox, note, 'wie een post op twee manieren ophaalt, hoort een bericht te zien');
  }
});

test('en de velden waar het misging zitten er echt in', () => {
  const o = uitOutbox(los('p1').id);
  const tags = (o.tag || []).filter((t) => t.type === 'Hashtag').map((t) => t.name).sort();
  assert.deepEqual(tags, ['#kawaii', '#leuk'], 'de hashtags, ook al staan ze niet in de tekst');
  assert.equal(o.type, 'Question', 'een peiling blijft een peiling');
  assert.ok(JSON.stringify(o).includes('https://elders.test/notes/1'), 'het citaat reist mee');
  // Zonder audio is de omslag een BIJLAGE (met alt als `name`); `image` krijgt
  // hij alleen als de bijlagen onderdrukt worden voor een speler.
  const o2 = uitOutbox(los('p2').id);
  const hoes = (o2.attachment || []).find((a) => String(a.url || '').endsWith('/media/hoes.jpg'));
  assert.equal(hoes && hoes.name, 'Een oranje hoes', 'de omslag houdt zijn alt-tekst');
  assert.ok(o.contentMap && o.contentMap.nl, 'de taal staat erbij');
});
