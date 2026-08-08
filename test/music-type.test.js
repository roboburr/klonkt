// Welk soort uitgave is een post? (shaer-cyg)
//
// De regel gaat over IDENTITEIT en niet over tellen: een post neemt het type
// van zijn muziek over als hij precies EEN muzikale eenheid bevat. Zijn het er
// meer, dan is de post een post die naar muziek verwijst en houden de
// collecties hun eigen identiteit -- en vervalt de reden om de posttitel en
// -cover te lenen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { postMusicType } = await import('../src/services/music/index.js');

test('geen muziek: geen type', () => {
  assert.equal(postMusicType('<p>gewoon een bericht</p>'), null);
  assert.equal(postMusicType(''), null);
  assert.equal(postMusicType(null), null);
});

test('losse tracks worden een playlist, en lenen de metadata van de post', () => {
  const r = postMusicType('Twee nieuwe: [[track:a]] en [[track:b]]');
  assert.equal(r.type, 'playlist');
  assert.deepEqual(r.tracks, ['a', 'b']);
  assert.equal(r.leentMetadata, true);
});

test('ook EEN losse track wordt een playlist', () => {
  // Naar buiten toe is er dan altijd een collectie om naar te wijzen. Dat
  // "Playlist" boven een enkel nummer gek leest is een weergavekwestie.
  assert.equal(postMusicType('[[track:a]]').type, 'playlist');
});

test('een playlist blijft een playlist', () => {
  const r = postMusicType('Nieuw: [[playlist:nachtlicht]]');
  assert.equal(r.type, 'playlist');
  assert.deepEqual(r.collectie, { soort: 'playlist', id: 'nachtlicht' });
  assert.equal(r.leentMetadata, true);
});

test('een album-insluiting is ook een collectie, en telt als album', () => {
  // Robins regel noemde alleen playlists; [[album:naam]] groepeert net zo goed
  // tracks. Hem als losse tracks tellen zou een albumpost tot playlist maken.
  const r = postMusicType('Luister [[album:De Plaat]]');
  assert.equal(r.type, 'album');
  assert.deepEqual(r.collectie, { soort: 'album', naam: 'De Plaat' });
});

test('een collectie MET losse tracks is een album, en die losse zijn bonus', () => {
  const r = postMusicType('[[playlist:nachtlicht]] plus [[track:x]] en [[track:y]]');
  assert.equal(r.type, 'album');
  assert.equal(r.collectie.id, 'nachtlicht');
  assert.deepEqual(r.bonus, ['x', 'y'], 'geen rommelrestje maar bonus-tracks');
  assert.deepEqual(r.tracks, [], 'de losse zitten in bonus, niet twee keer');
  assert.equal(r.leentMetadata, true);
});

test('TWEE collecties: de post blijft een post en leent niets', () => {
  const r = postMusicType('[[playlist:een]] en ook [[playlist:twee]]');
  assert.equal(r.type, 'post');
  assert.equal(r.collecties.length, 2);
  assert.equal(r.leentMetadata, false,
    'bij twee is de post niet meer de drager van EEN identiteit');
});

test('twee collecties van verschillende soort tellen ook als twee', () => {
  const r = postMusicType('[[playlist:een]] naast [[album:De Plaat]]');
  assert.equal(r.type, 'post');
  assert.equal(r.collecties.length, 2);
});

test('dezelfde insluiting twee keer is EEN collectie', () => {
  // Anders maakt een herhaalde shortcode van een albumpost stilletjes een
  // gewone post.
  const r = postMusicType('[[playlist:een]] ... en nog eens [[playlist:een]]');
  assert.equal(r.type, 'playlist');
  assert.equal(r.collectie.id, 'een');
});

test('dezelfde track twee keer telt ook maar een keer', () => {
  assert.deepEqual(postMusicType('[[track:a]] [[track:a]] [[track:b]]').tracks, ['a', 'b']);
});
