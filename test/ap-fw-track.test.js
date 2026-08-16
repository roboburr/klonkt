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

test('een track zonder uitgave draagt GEEN album', () => {
  // Dit stond er in stap 1 als "nog geen album, want we hebben er geen object
  // voor". Sinds stap 2 hebben we dat wel -- de album-playlist -- en is de regel
  // scherper: geen uitgave, geen veld. De tekstkolom `album` op de track blijft
  // buiten de draad, want dat is een label en geen adres.
  db.prepare("INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES ('m9','s1','los.mp3','a/los.mp3','audio/mpeg',10)").run();
  db.prepare("INSERT INTO audio_tracks (id, site_id, title, album, media_id, fedi_open) VALUES ('t9','s1','Losse track','Een Albumnaam','m9',1)").run();
  const a = audio('t9');
  assert.equal(a.track.album, undefined, 'een albumNAAM is geen album');
  assert.equal(a.album, undefined);
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

// ── het album ingesloten (shaer-756s, stap 2) ────────────────────────
//
// Hun TrackSerializer heeft `album = AlbumSerializer()`: een OBJECT met name,
// published en een eigen artist_credit. Een kale URI expandeert naar een knoop
// met alleen een @id en valt daar af -- dat is precies waarom Emissary's tracks
// bij Funkwhale ook stranden.

db.prepare(`INSERT INTO playlists (id, site_id, title, artist, year, cover_url, kind, release_date, mb_release_id, created_at)
            VALUES ('de-plaat','s1','De Plaat','De Band',2024,'/media/hoes.jpg','album','2024-03-15','7c5a9b2e-1111-4222-8333-944455556666','2026-01-01T00:00:00Z')`).run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('de-plaat','t1',1)").run();
// t2 zit in een MIXTAPE en hoort dus geen album te krijgen.
db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES ('de-mix','s1','De Mix','playlist')").run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('de-mix','t2',1)").run();

test('een track op een uitgave draagt het album als OBJECT', () => {
  const a = audio('t1');
  const al = a.track.album;
  assert.ok(al && typeof al === 'object', 'album is geen object');
  assert.equal(al.type, 'Album');
  assert.equal(al.id, `${BASE}/ap/users/band/playlists/de-plaat`, 'het id is de bestaande collectie');
  assert.equal(al.name, 'De Plaat');
  assert.ok(al.published, 'MusicEntitySerializer eist published');
  assert.equal(al.released, '2024-03-15');
  assert.equal(al.musicbrainzId, '7c5a9b2e-1111-4222-8333-944455556666');
  assert.ok(Array.isArray(al.artist_credit) && al.artist_credit.length >= 1, 'album zonder artist_credit');
  assert.equal(al.image.type, 'Image');
  // Ook als URI op de Audio zelf -- Funkwhale 2.0 en Emissary doen dat allebei.
  assert.equal(a.album, al.id);
});

test('een track in een MIXTAPE krijgt geen album', () => {
  // Een afspeellijst is geen uitgave. Zou hij hier een album krijgen, dan was
  // het onderscheid album/playlist decoratie.
  const a = audio('t2');
  assert.equal(a.track.album, undefined);
  assert.equal(a.album, undefined);
});

test('track en album delen dezelfde artiest', () => {
  // Twee keer los bouwen is hoe ze uit elkaar gaan lopen; er is een functie.
  const a = audio('t1');
  assert.deepEqual(a.track.artist_credit[0].artist, a.track.album.artist_credit[0].artist);
});

test('de playlist-collectie draagt de albumvelden, met type als STRING', () => {
  const pl = db.prepare("SELECT * FROM playlists WHERE id = 'de-plaat'").get();
  const col = AP.buildPlaylistCollection(BASE, site, pl, AP.playlistOpenTracks('de-plaat'));
  assert.equal(typeof col.type, 'string', 'een array breekt lezers die type als tekst uitpakken');
  assert.equal(col.type, 'OrderedCollection');
  assert.equal(col.released, '2024-03-15');
  assert.equal(col.musicbrainzId, '7c5a9b2e-1111-4222-8333-944455556666');
  assert.ok(col.artist_credit);
});

test('een mixtape-collectie krijgt GEEN albumvelden', () => {
  const pl = db.prepare("SELECT * FROM playlists WHERE id = 'de-mix'").get();
  const col = AP.buildPlaylistCollection(BASE, site, pl, AP.playlistOpenTracks('de-mix'));
  assert.equal(col.released, undefined);
  assert.equal(col.artist_credit, undefined);
});
