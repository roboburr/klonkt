// Een track wijst naar de post die hem uitbrengt (shaer-0nh).
//
// Aanleiding: sinds Create(Audio) in de outbox staat (fb22f78) bouwt Shaer zijn
// HomeBase-feed uit diezelfde outbox, en maakte het van elke Audio een lege
// kaart -- een Audio heeft geen `content` en onze `url` is een Link-array.
//
// De relatie stond alleen in posts.content ([[track:]], [[playlist:]],
// [[album:]]) en nergens op de draad. Nu wel: AS2-kern `context` wijst naar de
// Note van de post, en de text/html-link vooraan wijst naar de pagina. Een
// lezer die de post al heeft kan het nummer daarmee overslaan in plaats van er
// een dode kaart van te maken.
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

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, duration, media_id, album, fedi_open) VALUES (?,?,?,?,?,?,1)');
for (const [id, titel, album] of [['t-los', 'Losse track', null], ['t-pl', 'Via playlist', null],
  ['t-alb', 'Via album', 'De Plaat'], ['t-wees', 'Nergens ingesloten', null]]) {
  insM.run('m-' + id, 's1', id + '.mp3', 'audio/' + id + '.mp3', 'audio/mpeg');
  insT.run(id, 's1', titel, 60, 'm-' + id, album);
}
db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES ('plaat','s1','De Plaat','album')").run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('plaat','t-pl',1)").run();

const insP = db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
                         VALUES (?,?,?,?,?,?,'published',?)`);
insP.run('p-los', 's1', 'u1', 'losse-post', 'Losse post', 'Hier: [[track:t-los]]', '2026-01-01T00:00:00Z');
insP.run('p-pl', 's1', 'u1', 'playlist-post', 'Playlist-post', 'Nieuw album [[playlist:plaat]]', '2026-02-01T00:00:00Z');
insP.run('p-alb', 's1', 'u1', 'album-post', 'Album-post', 'Luister [[album:De Plaat]]', '2026-03-01T00:00:00Z');

const site = () => db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
const audioVoor = (id) => {
  const r = AP.siteOpenTracks('s1').find((x) => x.id === id);
  return AP.buildTrackAudio(BASE, site(), r);
};

test('rechtstreeks ingesloten: context wijst naar de Note van die post', () => {
  const a = audioVoor('t-los');
  assert.equal(a.context, 'https://test.example/ap/notes/p-los');
  assert.deepEqual(a.url[0], { type: 'Link', href: 'https://test.example/losse-post', mediaType: 'text/html' },
    'de post staat VOORAAN, zoals Funkwhale zijn trackpagina zet');
  assert.equal(a.url[1].mediaType, 'audio/mpeg', 'het bestand komt daarna');
});

test('via een playlist gevonden', () => {
  assert.equal(audioVoor('t-pl').context, 'https://test.example/ap/notes/p-pl');
});

test('via een albumnaam gevonden', () => {
  assert.equal(audioVoor('t-alb').context, 'https://test.example/ap/notes/p-alb');
});

test('een track die nergens is ingesloten krijgt GEEN context', () => {
  const a = audioVoor('t-wees');
  assert.equal(a.context, undefined, 'niets verzinnen als er geen post is');
  assert.equal(a.url.length, 1, 'dan ook geen text/html-link');
  assert.equal(a.url[0].mediaType, 'audio/mpeg');
});

test('rechtstreeks wint van playlist wint van album', () => {
  // t-pl zit in playlist "plaat"; die playlist is ook een album met dezelfde
  // naam. Sluit een NIEUWERE post hem rechtstreeks in, dan wint die -- de
  // specifiekste insluiting, niet de laatste.
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
              VALUES ('p-direct','s1','u1','direct-post','Direct','Deze: [[track:t-pl]]','published','2025-01-01T00:00:00Z')`).run();
  assert.equal(audioVoor('t-pl').context, 'https://test.example/ap/notes/p-direct',
    'ouder maar specifieker gaat voor');
  db.prepare("DELETE FROM posts WHERE id = 'p-direct'").run();
});

test('een concept telt niet als host', () => {
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status)
              VALUES ('p-concept','s1','u1','concept','Concept','[[track:t-wees]]','draft')`).run();
  assert.equal(audioVoor('t-wees').context, undefined, 'alleen gepubliceerde posts hosten iets');
  db.prepare("DELETE FROM posts WHERE id = 'p-concept'").run();
});

test('de collectie doet EEN zoekopdracht en levert dezelfde koppelingen', () => {
  const col = AP.buildTrackCollection(BASE, site(), AP.siteOpenTracks('s1'));
  const perNaam = Object.fromEntries(col.orderedItems.map((a) => [a.name, a.context]));
  assert.equal(perNaam['Losse track'], 'https://test.example/ap/notes/p-los');
  assert.equal(perNaam['Via playlist'], 'https://test.example/ap/notes/p-pl');
  assert.equal(perNaam['Nergens ingesloten'], undefined);
});

test('en de outbox draagt de context ook', () => {
  const ob = AP.buildOutbox(BASE, site(), [], AP.siteOpenTracks('s1'));
  const c = ob.orderedItems.find((x) => (x.object || {}).name === 'Losse track');
  assert.equal(c.object.context, 'https://test.example/ap/notes/p-los');
});
