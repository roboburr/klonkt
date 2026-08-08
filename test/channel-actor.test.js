// De Klonkt-actor als kanaal, en Audio als eigen soort in de tijdlijn
// (shaer-0nh, Robins besluit 7-8).
//
// Twee kanten. Uitgaand: de actor adverteert zijn webpagina en zijn RSS-feed
// als Link-array, met een category zodra er muziek is. Inkomend: een
// Create(Audio) van een kanaal wordt een tijdlijnrij met een echte speler --
// zonder de Audio tot Note om te vormen, want die soort willen we houden.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');
const site = () => db.prepare("SELECT s.*, (SELECT slug FROM sites WHERE is_primary = 1) AS primary_slug FROM sites s WHERE s.id = 's1'").get();

test('de actor draagt zijn webpagina en zijn RSS-feed als Link-array', () => {
  const a = AP.buildActor(BASE, site());
  assert.ok(Array.isArray(a.url), 'url is een array, geen string');
  assert.deepEqual(a.url[0], { type: 'Link', href: 'https://test.example/', mediaType: 'text/html' },
    'de webpagina staat VOORAAN: wie er maar een verwacht, pakt de eerste');
  assert.deepEqual(a.url[1], { type: 'Link', href: 'https://test.example/feed.xml', mediaType: 'application/rss+xml' });
});

test('zonder muziek geen category -- liever geen label dan een verkeerd label', () => {
  assert.equal(AP.buildActor(BASE, site()).category, undefined);
});

test('met muziek is de category "music"', () => {
  db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1)')
    .run('m1', 's1', 'a.mp3', 'audio/a.mp3', 'audio/mpeg');
  db.prepare('INSERT INTO audio_tracks (id, site_id, title, media_id) VALUES (?,?,?,?)')
    .run('t1', 's1', 'Een nummer', 'm1');
  assert.equal(AP.buildActor(BASE, site()).category, 'music');
});

// ── inkomend ────────────────────────────────────────────────────────────────

const AUDIO = {
  id: 'https://audio.example/federation/music/tracks/1',
  type: 'Audio',
  name: '0METAL MARIO - PINK - 140 bpm',
  duration: 'PT103S',
  published: '2026-08-07T12:00:00Z',
  image: { type: 'Image', url: 'https://audio.example/covers/1.jpg', mediaType: 'image/jpeg' },
  url: [
    { type: 'Link', href: 'https://audio.example/library/tracks/1', mediaType: 'text/html' },
    { type: 'Link', href: 'https://audio.example/media/1.mp3', mediaType: 'audio/mpeg' },
  ],
};

test('een Audio blijft een Audio en levert een speler plus hoes', () => {
  const f = AP.timelineFields(AUDIO);
  assert.equal(AUDIO.type, 'Audio', 'het bronobject is niet tot Note omgevormd');
  assert.equal(f.url, 'https://audio.example/library/tracks/1', 'de text/html-link is de link van het item');
  assert.deepEqual(f.atts, [
    { url: 'https://audio.example/covers/1.jpg', type: 'image/jpeg' },
    { url: 'https://audio.example/media/1.mp3', type: 'audio/mpeg' },
  ], 'eerst kijken, dan luisteren -- en audio/* maakt er in de Krant een speler van');
  assert.match(f.html, /0METAL MARIO/, 'de titel is de inhoud; een Audio heeft geen content');
});

test('een titel met HTML erin gaat door de sanitizer', () => {
  const f = AP.timelineFields({ ...AUDIO, name: 'Track <script>alert(1)</script>' });
  assert.ok(!/<script/i.test(f.html), 'geen script uit een vreemde titel');
});

test('een Audio zonder audio-link levert geen speler, maar breekt ook niet', () => {
  const f = AP.timelineFields({ ...AUDIO, url: [{ type: 'Link', href: 'https://audio.example/x', mediaType: 'text/html' }] });
  assert.ok(!f.atts.some((a) => /^audio\//.test(a.type)), 'niets om af te spelen');
  assert.equal(f.url, 'https://audio.example/x');
});

test('een kale string-url telt als webpagina, nooit als geluid', () => {
  // Zonder mediaType is een speler eropzetten fout: dan bieden we een
  // HTML-pagina als audiobestand aan.
  const f = AP.timelineFields({ ...AUDIO, url: 'https://audio.example/los' });
  assert.equal(f.url, 'https://audio.example/los');
  assert.ok(!f.atts.some((a) => /^audio\//.test(a.type)));
});

test('een gewone Note gedraagt zich onveranderd', () => {
  const f = AP.timelineFields({
    id: 'https://elders.example/n/1', type: 'Note', content: '<p>hallo</p>',
    url: 'https://elders.example/n/1',
    attachment: [{ type: 'Document', url: 'https://elders.example/p.jpg', mediaType: 'image/jpeg' }],
  });
  assert.match(f.html, /hallo/);
  assert.deepEqual(f.atts, [{ url: 'https://elders.example/p.jpg', type: 'image/jpeg' }]);
  assert.equal(f.url, 'https://elders.example/n/1');
});
