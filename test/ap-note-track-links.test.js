// De chips in het lijf van een Note krijgen een eigen URL (shaer-38y).
//
// Eerder was dit een vetgedrukte opsomming van titels met een enkele "listen
// on"-link naar de post als geheel: vijf namen waar een lezer niets mee kon.
// Elke track heeft op de postpagina al een anker (#track-<id>) -- direct
// ingesloten, in een album of in een playlist -- dus elke naam kan naar precies
// het nummer wijzen waar hij bij hoort.
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
  .run('u1', 'robin', 'r@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'band', 'De Band', 'u1');

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, album, duration, media_id, fedi_open) VALUES (?,?,?,?,?,?,?)');
insM.run('m1', 's1', 'een.mp3', 'audio/een.mp3', 'audio/mpeg');
insM.run('m2', 's1', 'twee.mp3', 'audio/twee.mp3', 'audio/mpeg');
insM.run('m3', 's1', 'drie.mp3', 'audio/drie.mp3', 'audio/mpeg');
insT.run('t1', 's1', 'Eerste', 'De Plaat', 200, 'm1', 1);
insT.run('t2', 's1', 'Tweede', 'De Plaat', 180, 'm2', 1);
insT.run('t3', 's1', 'Derde', null, 160, 'm3', 1);

db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES ('lijst','s1','De Lijst','playlist')").run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('lijst','t3',0)").run();

const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
const note = (content, id = 'p1') =>
  AP.buildNote(BASE, site, { id, slug: id, title: 'T', content, status: 'published' });

test('een losse track wordt een link naar zijn eigen anker', () => {
  const c = note('[[track:t1]]').content;
  assert.ok(c.includes(`<a href="${BASE}/p1#track-t1">Eerste</a>`), c.slice(-300));
});

test('meerdere tracks: elk zijn eigen link, in de volgorde van de post', () => {
  const c = note('[[track:t2]] en [[track:t1]]', 'p2').content;
  const namen = [...c.matchAll(/#track-(t\d)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(namen, [['t2', 'Tweede'], ['t1', 'Eerste']]);
});

test('een album-insluiting levert links per track, niet een albumnaam', () => {
  const c = note('[[album:De Plaat]]', 'p3').content;
  assert.ok(c.includes(`#track-t1">Eerste</a>`));
  assert.ok(c.includes(`#track-t2">Tweede</a>`));
});

test('een playlist ook -- die gaf eerder helemaal geen namen', () => {
  const c = note('[[playlist:lijst]]', 'p4').content;
  assert.ok(c.includes(`#track-t3">Derde</a>`), 'de tracks van de lijst staan er nu bij');
});

test('een albumnaam zonder tracks blijft gewone tekst', () => {
  const c = note('[[album:Bestaat Niet]]', 'p5').content;
  assert.ok(c.includes('Bestaat Niet'));
  assert.ok(!/#track-[^"]*">Bestaat Niet/.test(c), 'geen link naar een anker dat er niet is');
});

test('dezelfde track twee keer levert een link, niet twee', () => {
  const c = note('[[track:t1]] en nog eens [[track:t1]]', 'p6').content;
  assert.equal([...c.matchAll(/#track-t1"/g)].length, 1);
});

test('en de listen-link naar de post zelf blijft staan', () => {
  const c = note('[[track:t1]]', 'p7').content;
  assert.ok(/listen on/.test(c), 'de uitnodiging naar de pagina als geheel verdwijnt niet');
});
