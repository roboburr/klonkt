// Welk soort uitgave is een BESTAANDE post? (shaer-cyg)
//
// Nieuwe posts krijgen hun type uit de keuze -- album of playlist wordt gekozen
// als de playlist wordt gemaakt. Deze afleiding is er voor wat er al staat: de
// type=audio posts van voor die keuze. De regel gaat over IDENTITEIT en niet
// over tellen: een post neemt het type van zijn muziek over als hij precies EEN
// muzikale eenheid bevat. Zijn het er meer, dan is de post een post die naar
// muziek verwijst en houden de collecties hun eigen identiteit -- en vervalt de
// reden om de posttitel en -cover te lenen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const db = dbMod.default;
const { postMusicType } = await import('../src/services/music/index.js');

const SITE = 'site-muziek';
const ANDERE = 'site-anders';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'r@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run(SITE, 'muziek', 'Muziek', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run(ANDERE, 'anders', 'Anders', 'u1');

const maakPlaylist = (id, kind, siteId = SITE) =>
  db.prepare('INSERT INTO playlists (id, site_id, title, kind) VALUES (?, ?, ?, ?)')
    .run(id, siteId, id, kind);

maakPlaylist('nachtlicht', 'playlist');
maakPlaylist('de-plaat', 'album');
maakPlaylist('tweede', 'playlist');
maakPlaylist('elders', 'playlist', ANDERE);

const type = (c) => postMusicType(c, SITE);

test('geen muziek: geen type', () => {
  assert.equal(type('<p>gewoon een bericht</p>'), null);
  assert.equal(type(''), null);
  assert.equal(type(null), null);
});

test('losse tracks worden een playlist, en lenen de metadata van de post', () => {
  const r = type('Twee nieuwe: [[track:a]] en [[track:b]]');
  assert.equal(r.type, 'playlist');
  assert.deepEqual(r.tracks, ['a', 'b']);
  assert.equal(r.leentMetadata, true);
});

test('ook EEN losse track wordt een playlist', () => {
  // Naar buiten toe is er dan altijd een collectie om naar te wijzen. Dat
  // "Playlist" boven een enkel nummer gek leest is een weergavekwestie.
  assert.equal(type('[[track:a]]').type, 'playlist');
});

test('de post neemt de GEKOZEN soort van de playlist over', () => {
  // De kern van Robins besluit: album of playlist is bij het maken van de
  // playlist al gekozen. Hier wordt hij opgezocht, niet afgeleid.
  assert.equal(type('Nieuw: [[playlist:nachtlicht]]').type, 'playlist');
  assert.equal(type('Nieuw: [[playlist:de-plaat]]').type, 'album',
    'een post om een album is een album, ook al heet de shortcode playlist');
});

test('de collectie draagt haar eigen soort mee', () => {
  const r = type('Nieuw: [[playlist:nachtlicht]]');
  assert.deepEqual(r.collectie, { soort: 'playlist', id: 'nachtlicht' });
  assert.equal(r.leentMetadata, true);
});

test('een album-insluiting is ook een collectie, en telt als album', () => {
  // [[album:naam]] groepeert tracks op hun albumveld -- geen playlist-rij, dus
  // geen gekozen soort. Hem als losse tracks tellen zou een albumpost tot
  // playlist maken.
  const r = type('Luister [[album:De Plaat]]');
  assert.equal(r.type, 'album');
  assert.deepEqual(r.collectie, { soort: 'album', naam: 'De Plaat' });
});

test('een collectie MET losse tracks is een album, en die losse zijn bonus', () => {
  const r = type('[[playlist:nachtlicht]] plus [[track:x]] en [[track:y]]');
  assert.equal(r.type, 'album', 'ook al is de playlist zelf een playlist');
  assert.equal(r.collectie.id, 'nachtlicht');
  assert.deepEqual(r.bonus, ['x', 'y'], 'geen rommelrestje maar bonus-tracks');
  assert.deepEqual(r.tracks, [], 'de losse zitten in bonus, niet twee keer');
  assert.equal(r.leentMetadata, true);
});

test('TWEE collecties: de post blijft een post en leent niets', () => {
  const r = type('[[playlist:nachtlicht]] en ook [[playlist:tweede]]');
  assert.equal(r.type, 'post');
  assert.equal(r.collecties.length, 2);
  assert.equal(r.leentMetadata, false,
    'bij twee is de post niet meer de drager van EEN identiteit');
});

test('twee collecties van verschillende soort tellen ook als twee', () => {
  const r = type('[[playlist:nachtlicht]] naast [[album:De Plaat]]');
  assert.equal(r.type, 'post');
  assert.equal(r.collecties.length, 2);
});

test('dezelfde insluiting twee keer is EEN collectie', () => {
  // Anders maakt een herhaalde shortcode van een albumpost stilletjes een
  // gewone post.
  const r = type('[[playlist:nachtlicht]] ... en nog eens [[playlist:nachtlicht]]');
  assert.equal(r.type, 'playlist');
  assert.equal(r.collectie.id, 'nachtlicht');
});

test('dezelfde track twee keer telt ook maar een keer', () => {
  assert.deepEqual(type('[[track:a]] [[track:a]] [[track:b]]').tracks, ['a', 'b']);
});

test('onbekende playlist: gewone post, niets verzonnen', () => {
  // Robins laatste optie voor een onbekende situatie. De insluiting blijft
  // staan en houdt de post als context; alleen het label wordt niet geraden.
  const r = type('[[playlist:bestaat-niet]]');
  assert.equal(r.type, 'post');
  assert.deepEqual(r.onbekend, ['bestaat-niet']);
  assert.equal(r.leentMetadata, false);
});

test('een playlist van een ANDERE site telt niet als de onze', () => {
  const r = type('[[playlist:elders]]');
  assert.equal(r.type, 'post');
  assert.deepEqual(r.onbekend, ['elders']);
});

test('zonder site is er niets op te zoeken, dus geen type verzinnen', () => {
  assert.equal(postMusicType('[[playlist:nachtlicht]]').type, 'post');
});
