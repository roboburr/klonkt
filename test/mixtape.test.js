// De mixtape: een bandje als eigen soort (Robins idee, 21-8).
//
// Een playlist kon album of playlist zijn. Die keuze stond vijf keer als
// `x === 'playlist' ? 'playlist' : 'album'` verspreid over drie bestanden, en
// zo'n vorm valt bij een derde soort niet om -- hij SLIKT hem. Een mixtape zou
// stilzwijgend een album worden en als Album de deur uit gaan. Die tests staan
// hier dus voorop.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();

const { normKind, isUitgave } = await import('../src/services/PlaylistService.js');
const PlaylistService = (await import('../src/services/PlaylistService.js')).default;
const { afleidenUitInsluitingen, SOORTEN } = await import('../src/assets/js/shared/post-music-type.js');
const muziek = await import('../src/services/music/index.js');

const BASE = 'https://test.example';
const site = { id: 's1', slug: 'robo', title: 'Soundfabrics' };

test('mixtape is een echte soort, en onbekend blijft album', () => {
  assert.equal(normKind('mixtape'), 'mixtape');
  assert.equal(normKind('MIXTAPE '), 'mixtape', 'invoer uit een formulier is niet genormaliseerd');
  assert.equal(normKind('cassette'), 'album', 'iets onbekends wordt geen nieuwe soort');
  assert.equal(normKind(undefined), 'album');
  assert.deepEqual(SOORTEN, ['album', 'playlist', 'mixtape']);
});

test('een bandje is geen uitgave: geen uitgavedatum, geen release-id', () => {
  assert.equal(isUitgave('album'), true);
  assert.equal(isUitgave('mixtape'), false);
  assert.equal(isUitgave('playlist'), false);
});

test('een post om een mixtape IS een mixtape', () => {
  const kindVan = (id) => (id === 'de-mixtape' ? 'mixtape' : null);
  const r = afleidenUitInsluitingen('<p>hier</p>[[playlist:de-mixtape]]', kindVan);
  assert.equal(r.type, 'mixtape');
  assert.equal(r.leentMetadata, true, 'de post leent zijn titel en hoes uit');
});

test('een mixtape met losse tracks erbij blijft een mixtape', () => {
  // De oude regel maakte van collectie + losse tracks een album. Voor een
  // uitgave klopt dat (bonustracks), voor een bandje niet.
  const kindVan = (id) => (id === 'tape' ? 'mixtape' : 'album');
  const tape = afleidenUitInsluitingen('[[playlist:tape]][[track:abc]]', kindVan);
  assert.equal(tape.type, 'mixtape');
  assert.deepEqual(tape.bonus, ['abc']);

  // En het oude gedrag voor een album blijft staan: bestaande posts mogen niet
  // stilletjes van soort wisselen.
  const plaat = afleidenUitInsluitingen('[[playlist:plaat]][[track:abc]]', kindVan);
  assert.equal(plaat.type, 'album');
});

test('het Mixtape-object is een enkel object met de nummers erin', () => {
  const rows = [
    { id: 't1', title: 'Kant A', duration: 100, filename: 'a.mp3', mime_type: 'audio/mpeg', size: 1 },
    { id: 't2', title: 'Kant B', duration: 44, filename: 'b.mp3', mime_type: 'audio/mpeg', size: 1 },
  ];
  const pl = { id: 'tape', title: 'De Mixtape', artist: 'robo', created_at: '2026-08-21T10:00:00Z' };
  const tape = muziek.buildMixtapeObject(BASE, site, pl, rows);

  // type is een STRING. Een array zou geldig AS2 zijn en toch fout: een lezer
  // die het als tekst uitpakt (Shaer) verliest dan stil het hele object.
  assert.equal(typeof tape.type, 'string');
  assert.equal(tape.type, 'Mixtape');
  assert.equal(tape.id, `${BASE}/ap/users/robo/playlists/tape`);

  // Een enkel object, samengesteld uit playlistelementen.
  assert.equal(tape.totalItems, 2);
  assert.equal(tape.orderedItems.length, 2);
  assert.equal(tape.orderedItems[0].type, 'Audio');
  assert.equal(tape.orderedItems[0].id, `${BASE}/ap/users/robo/tracks/t1`);
  assert.equal(tape.orderedItems[1].name, 'Kant B');

  // De lengte van het bandje: 100 + 44.
  assert.equal(tape.duration, 'PT144S');

  // Geen uitgavevelden. Die zouden beweren dat dit een plaat is.
  assert.equal(tape.released, undefined);
  assert.equal(tape.musicbrainzId, undefined);
  // En geen eigen stream: het is een omhulling, niet een gerenderd bestand.
  assert.equal(tape.url, undefined);
});

test('een gat in de duur levert geen verzonnen totaal op', () => {
  const rows = [
    { id: 't1', title: 'A', duration: 100, filename: 'a.mp3', mime_type: 'audio/mpeg', size: 1 },
    { id: 't2', title: 'B', duration: 0, filename: 'b.mp3', mime_type: 'audio/mpeg', size: 1 },
  ];
  const tape = muziek.buildMixtapeObject(BASE, site, { id: 'x', title: 'X' }, rows);
  assert.equal(tape.duration, undefined, 'liever geen veld dan een som met gaten');
});

test('de collectie van een mixtape draagt zijn velden, en blijft OrderedCollection', () => {
  const rows = [{ id: 't1', title: 'A', duration: 60, filename: 'a.mp3', mime_type: 'audio/mpeg', size: 1 }];
  const uit = muziek.buildPlaylistCollection(BASE, site, { id: 'tape', title: 'De Mixtape', kind: 'mixtape' }, rows);
  assert.equal(uit.type, 'OrderedCollection', 'het adres blijft een collectie voor wie hem zo ophaalt');
  assert.equal(typeof uit.type, 'string');
  assert.equal(uit.duration, 'PT60S', 'de mixtape-velden horen hier ook te staan');
  // Uitgavevelden horen er NIET op: dit is geen plaat.
  assert.equal(uit.released, undefined);
  assert.equal(uit.musicbrainzId, undefined);
});

test('opslaan en teruglezen houdt de soort vast', () => {
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'baas', 'b@t.nl', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'robo', 'Soundfabrics', 'u1');

  const id = PlaylistService.create('s1', { title: 'De Mixtape', kind: 'mixtape', tracks: [] });
  assert.ok(id, 'aanmaken hoort te lukken');
  assert.equal(PlaylistService.get('s1', id).kind, 'mixtape', 'de soort mag niet terugvallen op album');
  assert.equal(PlaylistService.list('s1').find((p) => p.id === id).kind, 'mixtape');

  // En de server leidt het posttype er ook echt uit af, via de opzoeker die de
  // database raadpleegt -- niet via de meegegeven testfunctie hierboven.
  const r = muziek.postMusicType(`[[playlist:${id}]]`, 's1');
  assert.equal(r.type, 'mixtape');
});
