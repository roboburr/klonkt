// `fw:track` op onze Audio-objecten (shaer-3f8a, spoor B stap 1).
//
// Twee onafhankelijke implementaties lezen dit veld: Funkwhale (verplicht in
// UploadSerializer) en Emissary 0.9.0, gemeten op bandwagon.fm 16-8. Emissary
// stuurt de kleine vorm -- type, id, name, album, position -- en die nemen we
// over, zonder album zolang dat bij ons geen object is (shaer-k37k).
//
// Wat deze test vastlegt is vooral het ID: het nummer krijgt een EIGEN
// identiteit met #track, niet die van het bestand. Emissary hergebruikt daar
// het object-id, en dan zijn de Audio en de Track in JSON-LD een knoop met twee
// typen. Wie dat 'opruimt' naar het kortere id haalt dat verschil weg, en dan
// staat er dat een mp3 een muziekstuk IS.
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

db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)')
  .run('m1', 's1', 'een.mp3', 'a/een.mp3', 'audio/mpeg', 2480880);
db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open, position) VALUES (?,?,?,?,?,?,?,?)')
  .run('t1', 's1', 'Het nummer', 'De Band', 103, 'm1', 1, 3);
// Eentje zonder positie: die mag het veld niet verzinnen.
db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)')
  .run('m2', 's1', 'twee.mp3', 'a/twee.mp3', 'audio/mpeg', 100);
db.prepare('INSERT INTO audio_tracks (id, site_id, title, media_id, fedi_open) VALUES (?,?,?,?,?)')
  .run('t2', 's1', 'Zonder plek', 'm2', 1);

const audio = (id) => AP.buildTrackAudio(BASE, site, AP.openTrack('s1', id), { hostPosts: null });

test('elke Audio draagt een track met de kleine Emissary-vorm', () => {
  const a = audio('t1');
  assert.ok(a.track, 'geen track op het object');
  assert.equal(a.track.type, 'Track');
  assert.equal(a.track.name, 'Het nummer');
  assert.equal(a.track.position, 3);
});

test('de track heeft een EIGEN id, niet dat van het bestand', () => {
  const a = audio('t1');
  assert.equal(a.track.id, `${a.id}#track`);
  assert.notEqual(a.track.id, a.id, 'een bestand is geen werk');
});

test('geen album zolang het bij ons geen object is', () => {
  // Een tekstkolom als URI meesturen is een adres beloven dat niet bestaat.
  assert.equal(audio('t1').track.album, undefined);
});

test('geen verzonnen positie', () => {
  assert.equal(audio('t2').track.position, undefined);
  assert.equal(audio('t2').track.name, 'Zonder plek');
});

test('de termen staan in de context, anders valt het veld weg', async () => {
  const core = await import('../src/services/ap-core.js');
  const term = core.AP_CONTEXT.find((x) => x && typeof x === 'object' && x.track);
  assert.ok(term, 'track staat in de context');
  // Letterlijk de vorm uit hun contexts.py (regel 293-306), zodat een lezer die
  // hun context laadt op dezelfde IRI's uitkomt als een lezer die de onze leest.
  assert.deepEqual(term.track, { '@id': 'fw:track', '@type': '@id' });
  assert.equal(term.Track, 'fw:Track');
});

test('de track komt overal mee, niet alleen op de losse ophaal', () => {
  // Bibliotheek, trackcollectie en losse ophaal bouwen alle drie via
  // buildTrackAudio -- dit is de test die dat vasthoudt als iemand er een
  // eigen bouwertje naast zet.
  const lib = AP.buildLibrary(BASE, site, AP.siteOpenTracks('s1'));
  for (const a of lib.items) assert.equal(a.track.type, 'Track', `${a.name} zonder track`);
  const col = AP.buildTrackCollection(BASE, site, AP.siteOpenTracks('s1'));
  for (const a of col.orderedItems) assert.equal(a.track.type, 'Track', `${a.name} zonder track`);
});

// ── artist_credit (shaer-3f8a, het gat naar hun ingest) ──────────────
//
// TrackSerializer (regel 1569) eist `artist_credit` met min_length=1, en elke
// ArtistCredit eist een Artist die zelf id, name en published nodig heeft
// (MusicEntitySerializer, regel 1278). Dat leek onmogelijk zolang een artiest
// bij ons tekst was -- tot de MusicBrainz-koppeling liet zien dat de ACTOR de
// artiest is.

test('de track draagt een artist_credit met een echte Artist', () => {
  const a = audio('t1');
  assert.ok(Array.isArray(a.track.artist_credit), 'geen lijst');
  assert.equal(a.track.artist_credit.length, 1);
  const ac = a.track.artist_credit[0];
  assert.equal(ac.type, 'ArtistCredit');
  assert.ok(ac.id && ac.published, 'ArtistCredit mist id of published');
  assert.equal(ac.artist.type, 'Artist');
  assert.equal(ac.artist.id, `${BASE}/ap/users/band`, 'de actor IS de artiest');
  assert.equal(ac.artist.name, 'De Band');
  assert.ok(ac.artist.published, 'Artist mist published');
});

test('de artiestnaam van de track gaat naar credit, niet naar de entiteit', () => {
  // De kolom is een credittekst, geen identiteit. Er een id van maken zou
  // dezelfde fout zijn als bij het album (shaer-756s).
  assert.equal(audio('t1').track.artist_credit[0].credit, 'De Band');
  assert.equal(audio('t2').track.artist_credit[0].credit, undefined, 'geen artiest, geen credit');
});

test('de track heeft published -- MusicEntitySerializer eist het', () => {
  assert.ok(audio('t1').track.published);
});

test('artist_credit is een @list in de context, anders vindt hun lezer niets', async () => {
  // Ze lezen dit met first_attr(FW.artist_credit, "@list"). Zonder de
  // container-declaratie expandeert onze array niet naar een @list en staat er
  // iets dat er goed uitziet en niet gevonden wordt.
  const core = await import('../src/services/ap-core.js');
  const term = core.AP_CONTEXT.find((x) => x && typeof x === 'object' && x.artist_credit);
  assert.deepEqual(term.artist_credit, { '@id': 'fw:artist_credit', '@type': '@id', '@container': '@list' });
  assert.equal(term.ArtistCredit, 'fw:ArtistCredit');
  assert.equal(term.Artist, 'fw:Artist');
});

test('musicbrainzId komt mee zodra de site gekoppeld is', () => {
  assert.equal(audio('t1').track.artist_credit[0].artist.musicbrainzId, undefined);
  db.prepare("UPDATE sites SET mb_artist_id = '5441c29d-3602-4898-b1a1-b77fa23b8e50' WHERE id = 's1'").run();
  const s2 = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const a = AP.buildTrackAudio(BASE, s2, AP.openTrack('s1', 't1'), { hostPosts: null });
  assert.equal(a.track.artist_credit[0].artist.musicbrainzId, '5441c29d-3602-4898-b1a1-b77fa23b8e50');
  db.prepare("UPDATE sites SET mb_artist_id = NULL WHERE id = 's1'").run();
});
