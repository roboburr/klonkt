// Audio overleeft een verhuizing. Formaat v2.
//
// Dit bestand bestaat door wat er op soundfabrics.nl gebeurde: 36 berichten
// kwamen goed over, 14 van de 140 nummers stonden er, en 13 daarvan speelden
// niet af. Drie oorzaken, alle drie hier vastgelegd:
//
//   1. Gehoste audio leeft BUITEN MEDIA_ROOT (eigen gated route). Het archief
//      droeg alleen bestanden onder media/, dus de exporter rekende er een
//      /media/../audio/x.mp3 van en de importer weigerde dat pad. Terecht: het
//      wijst buiten de mediamap. Gevolg was wel dat audio nooit kon aankomen.
//   2. De importer maakte een audio_tracks-rij aan ZONDER te kijken of het
//      bestand er was. Een nummer dat in de lijst staat en 404't bij play is
//      erger dan een nummer dat ontbreekt: het ziet eruit alsof het gelukt is,
//      dus je gooit je oude instantie weg.
//   3. Alleen audio die met [[track:]] in een bericht stond ging mee. Losse
//      nummers en playlists bleven achter (126 respectievelijk 11 stuks).
//
// Een verhuizing die je bibliotheek achterlaat is geen verhuizing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klonkt-audio-'));
const MEDIA = path.join(TMP, 'media');
const AUDIO = path.join(TMP, 'audio');
fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(AUDIO, { recursive: true });

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://oud.test';
process.env.MEDIA_PATH = MEDIA;
process.env.AUDIO_PATH = AUDIO;      // MOET voor de import van paths.js staan

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AX = await import('../src/services/ArchiveExportService.js');
const AI = await import('../src/services/ArchiveImportService.js');
const { AUDIO_ROOT } = await import('../src/config/paths.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Mijn site', 'u1');

const BYTES = (s) => Buffer.from(`RIFF${s}`.padEnd(64, '.'));

/** Schone lei: tabellen leeg en de audiomap leeg. Tests lekken anders in elkaar. */
function leeg() {
  for (const t of ['playlist_tracks', 'playlists', 'audio_tracks', 'media']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* tabel bestaat niet */ }
  }
  for (const f of fs.readdirSync(AUDIO)) { try { fs.unlinkSync(path.join(AUDIO, f)); } catch { /* niets */ } }
}

/** Een nummer met zijn bestand op de plek waar de SPELER het zoekt. */
function track(id, titel, { padInDb = null, schrijf = true } = {}) {
  const naam = `${id}.mp3`;
  const echt = path.join(AUDIO, naam);
  if (schrijf) fs.writeFileSync(echt, BYTES(id));
  db.prepare('INSERT OR REPLACE INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
    .run(`m-${id}`, 's1', naam, 'audio/mpeg', 1, padInDb || echt);
  db.prepare('INSERT OR REPLACE INTO audio_tracks (id, site_id, title, artist, media_id) VALUES (?,?,?,?,?)')
    .run(id, 's1', titel, 'Robin', `m-${id}`);
  return echt;
}

test('een nummer met een VEROUDERD pad in de database gaat gewoon mee', () => {
  leeg();
  // Dit is de stille moordenaar. Op sound-fabrics.com wees storage_path voor
  // 124 van de 139 nummers nog naar /srv/prutfolio/storage/audio, van voor een
  // dataverhuizing. De speler merkte niets (die zoekt op bestandsnaam in
  // AUDIO_ROOT), de exporter vond niets en liet ze weg. Zonder klacht.
  track('oudpad', 'Verouderd pad', { padInDb: '/srv/ergens/anders/oudpad.mp3' });
  const uit = AX.buildArchive('me');
  const rij = JSON.parse(uit.files.get('tracks.json').toString('utf8')).orderedItems.find((x) => x.id === 'oudpad');
  assert.equal(rij['shaer:availability'], 'included',
    'de exporter hoort te zoeken zoals de speler zoekt, niet zoals de database onthoudt');
  assert.deepEqual(uit.files.get(rij['shaer:file']), BYTES('oudpad'));
});

test('de hele rondgang: exporteren, importeren, en het geluid staat er', () => {
  leeg();
  track('a', 'Nummer A');
  track('b', 'Nummer B');
  const uit = AX.buildArchive('me');
  assert.equal(uit.counts.tracks, 2);

  // Een LEGE tweede installatie, met zijn eigen mappen.
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'klonkt-audio2-'));
  const doelAudio = path.join(TMP2, 'audio');
  fs.mkdirSync(doelAudio, { recursive: true });

  // AUDIO_ROOT ligt vast bij import, dus we importeren in DEZELFDE map en
  // controleren daarna dat het bestand er staat onder de naam uit het archief.
  leeg();
  assert.equal(fs.readdirSync(AUDIO).length, 0, 'schone lei');

  const rapport = AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test' });
  assert.equal(rapport.tracks, 2, 'beide nummers komen terug');
  assert.equal(rapport.tracksMissing, 0);

  const rijen = db.prepare('SELECT t.id, t.title, m.storage_path, m.size FROM audio_tracks t JOIN media m ON m.id = t.media_id ORDER BY t.id').all();
  assert.equal(rijen.length, 2);
  for (const r of rijen) {
    assert.ok(fs.existsSync(r.storage_path), `${r.title}: het bestand hoort er ECHT te staan`);
    assert.ok(r.size > 0, 'en de grootte klopt, geen 0 zoals bij de kapotte import');
    assert.ok(r.storage_path.startsWith(path.resolve(AUDIO_ROOT) + path.sep),
      'audio hoort in AUDIO_ROOT, niet onder de publieke mediamap');
  }
  fs.rmSync(TMP2, { recursive: true, force: true });
});

test('een nummer zonder bestand wordt NIET aangemaakt', () => {
  // De kern van de klacht: 13 nummers die bestonden en niet speelden. Liever
  // eerlijk weg dan zichtbaar kapot.
  leeg();
  track('zoek', 'Zoekgeraakt', { padInDb: '/bestaat/echt/niet.mp3', schrijf: false });
  const uit = AX.buildArchive('me');
  assert.equal(uit.counts.audioMissing, 1);

  leeg();
  const rapport = AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test' });
  assert.equal(rapport.tracks, 0);
  assert.equal(rapport.tracksMissing, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audio_tracks').get().n, 0,
    'geen rij zonder geluid: dat is precies de val die soundfabrics.nl opleverde');
  assert.ok(rapport.waarschuwingen.some((w) => /Zoekgeraakt/.test(w)),
    'en de gebruiker hoort te weten welk nummer er niet is');
});

test('playlists komen mee, met hun volgorde', () => {
  leeg();

  track('p1', 'Eerste');
  track('p2', 'Tweede');
  track('p3', 'Derde');
  db.prepare("INSERT INTO playlists (id, site_id, title, artist, kind) VALUES ('pl1','s1','Mijn plaat','Robin','album')").run();
  // Bewust NIET op alfabet: de volgorde is de hele playlist.
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('pl1','p3',0),('pl1','p1',1),('pl1','p2',2)").run();

  const uit = AX.buildArchive('me');
  assert.equal(uit.counts.playlists, 1);

  leeg();

  const rapport = AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test' });
  assert.equal(rapport.playlists, 1);
  const pl = db.prepare("SELECT * FROM playlists WHERE id = 'pl1'").get();
  assert.equal(pl.title, 'Mijn plaat');
  assert.equal(pl.kind, 'album');
  const volgorde = db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = 'pl1' ORDER BY position").all().map((r) => r.track_id);
  assert.deepEqual(volgorde, ['p3', 'p1', 'p2'], 'de volgorde IS de playlist');
});

test('een playlist verwijst nooit naar een nummer dat niet aankwam', () => {
  // Anders staat er een plaat met gaten erin die je niet kunt afspelen, en dat
  // is weer dezelfde soort halve waarheid.
  leeg();

  track('heel', 'Heel');
  track('stuk', 'Stuk', { padInDb: '/weg/stuk.mp3', schrijf: false });
  db.prepare("INSERT INTO playlists (id, site_id, title) VALUES ('pl2','s1','Half')").run();
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('pl2','heel',0),('pl2','stuk',1)").run();

  const uit = AX.buildArchive('me');
  leeg();

  const rapport = AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test' });
  const items = db.prepare("SELECT track_id FROM playlist_tracks WHERE playlist_id = 'pl2'").all().map((r) => r.track_id);
  assert.deepEqual(items, ['heel']);
  assert.ok(rapport.waarschuwingen.some((w) => /Half/.test(w)), 'en het wordt gemeld');
});

test('een droogloop telt de nummers maar schrijft niets', () => {
  leeg();
  track('d1', 'Droog');
  const uit = AX.buildArchive('me');

  leeg();

  const droog = AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test', dryRun: true });
  assert.equal(droog.tracks, 1, 'het verslag hoort te zeggen hoeveel nummers er zouden komen');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audio_tracks').get().n, 0, 'maar er staat niets');
  assert.equal(fs.readdirSync(AUDIO).length, 0, 'en er is geen bestand geschreven');
});


test('de hoes van een nummer reist mee als BESTAND, niet als losse verwijzing', () => {
  // Robin na de tweede ronde: "de audio tracks hadden images, die zijn niet
  // meegegaan". cover_url ging wel mee als string en het bestand niet, dus kwam
  // een nummer aan met een verwijzing naar een plaatje dat er niet was.
  // Dezelfde fout als bij de audio zelf, een laag hoger.
  leeg();
  const hoesDir = path.join(MEDIA, 'hoes');
  fs.mkdirSync(hoesDir, { recursive: true });
  const PNG = Buffer.from('nep-png-bytes');
  fs.writeFileSync(path.join(hoesDir, 'a.png'), PNG);
  track('h1', 'Met hoes');
  db.prepare("UPDATE audio_tracks SET cover_url = '/media/hoes/a.png' WHERE id = 'h1'").run();
  db.prepare("INSERT INTO playlists (id, site_id, title, cover_url) VALUES ('plh','s1','Plaat','/media/hoes/a.png')").run();
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('plh','h1',0)").run();

  const uit = AX.buildArchive('me');
  const rij = JSON.parse(uit.files.get('tracks.json').toString('utf8')).orderedItems[0];
  assert.ok(rij['shaer:coverFile'], 'de hoes hoort een plek in het archief te hebben');
  assert.deepEqual(uit.files.get(rij['shaer:coverFile']), PNG, 'met de echte bytes erin');
  const pl = JSON.parse(uit.files.get('playlists.json').toString('utf8')).orderedItems[0];
  assert.ok(pl['shaer:coverFile'], 'en de hoes van de plaat ook');

  leeg();
  AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test' });
  const t = db.prepare("SELECT cover_url FROM audio_tracks WHERE id = 'h1'").get();
  assert.ok(t.cover_url, 'na de import wijst het nummer naar een hoes');
  const opSchijf = path.join(MEDIA, t.cover_url.replace(/^\/media\//, ''));
  assert.deepEqual(fs.readFileSync(opSchijf), PNG, 'en die staat er ook echt');
});

test('een hoes die niet in het archief zit levert GEEN kapotte verwijzing op', () => {
  // Liever geen hoes dan een <img> die 404't. Dezelfde regel als bij de tracks.
  leeg();
  track('h2', 'Hoes zoek');
  db.prepare("UPDATE audio_tracks SET cover_url = '/media/bestaat/niet.png' WHERE id = 'h2'").run();
  const uit = AX.buildArchive('me');
  const rij = JSON.parse(uit.files.get('tracks.json').toString('utf8')).orderedItems[0];
  assert.equal(rij['shaer:coverFile'], undefined);

  leeg();
  AI.importArchive(uit.files, { slug: 'me', origin: 'https://nieuw.test' });
  assert.equal(db.prepare("SELECT cover_url FROM audio_tracks WHERE id = 'h2'").get().cover_url, null,
    'geen verwijzing naar een plaatje dat er niet is');
});

test('ook een zip-import buigt links naar de bronpost om', () => {
  // Robin: "het moet wel gebeuren bij migratie direct ook". Een zip-import is
  // net zo goed een verhuizing, dus dezelfde regel.
  leeg();
  try { db.prepare('DELETE FROM posts').run(); } catch { /* leeg */ }
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
              VALUES ('pl1','s1','u1','tiktik','TikTik','<p><a href="https://oud.test/tiktik?fc=2">luister</a></p>','published','2026-01-01T10:00:00Z')`).run();
  const uit = AX.buildArchive('me');

  db.prepare('DELETE FROM posts').run();
  // De import doet alsof het archief van oud.test komt; deze site is oud.test
  // niet, dus de links moeten om.
  const files = new Map(uit.files);
  const man = JSON.parse(files.get('manifest.json').toString('utf8'));
  man.origin = 'https://oud.test';
  files.set('manifest.json', Buffer.from(JSON.stringify(man)));

  const r = AI.importArchive(files, { slug: 'me', origin: 'https://nieuw.test' });
  const c = db.prepare("SELECT content FROM posts WHERE slug = 'tiktik'").get().content;
  assert.ok(c.includes('href="/tiktik?fc=2"'), `omgebogen naar hier, kreeg: ${c}`);
  assert.ok(!c.includes('oud.test'), 'niets wijst meer naar de bron');
  assert.equal(r.linksBijgetrokken, 1, 'en het verslag zegt het');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* niets */ } });
