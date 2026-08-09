// De post als uitgave (shaer-38y).
//
// Drie punten uit de bead: de volgorde van de post behouden, de lijst als
// geheel overnemen, en de metadata van de post lenen. Het derde is waar het om
// draait -- een collectie met alleen een naam is wat een Funkwhale-achtige
// lezer te mager vindt, en de post heeft wel een titel, tekst, hoes en tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const db = dbMod.default;
const M = await import('../src/services/music/index.js');

const BASE = 'https://test.example';
const SITE = 'site-1';
const site = { id: SITE, slug: 'muziek' };

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'r@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run(SITE, 'muziek', 'Muziek', 'u1');

let n = 0;
function maakTrack(id, titel) {
  const mediaId = 'm-' + id;
  db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)')
    .run(mediaId, SITE, id + '.mp3', '/x/' + id + '.mp3', 'audio/mpeg', 1000 + (n++));
  db.prepare('INSERT INTO audio_tracks (id, site_id, media_id, title, duration, fedi_open, position) VALUES (?,?,?,?,?,1,?)')
    .run(id, SITE, mediaId, titel, 100, 0);
}

function maakPost({ id, slug, titel, content, excerpt = '', cover = '', tags = '' }) {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, excerpt, content, cover_image_url, tags, status, type, created_at, updated_at, published_at)
              VALUES (?,?,?,'u1',?,?,?,?,?,'published','playlist',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`)
    .run(id, SITE, slug, titel, excerpt, content, cover, tags);
  return db.prepare('SELECT id, slug, title, excerpt, content, cover_image_url, tags FROM posts WHERE id = ?').get(id);
}

// Drie tracks, bewust in een andere vololgorde ingevoerd dan ze in de post staan.
maakTrack('t-een', 'Een');
maakTrack('t-twee', 'Twee');
maakTrack('t-drie', 'Drie');

const losse = maakPost({
  id: 'p-los', slug: 'drie-nieuwe', titel: 'Drie nieuwe nummers',
  content: 'Hier: [[track:t-drie]] dan [[track:t-een]] en tot slot [[track:t-twee]]',
  excerpt: 'Opgenomen op zolder, in een week.',
  cover: '/media/hoes.jpg',
  tags: 'lofi, zolder',
});

test('losse tracks in een post worden EEN collectie', () => {
  const col = M.buildPostTrackCollection(BASE, site, losse);
  assert.ok(col, 'er is een uitgave');
  assert.equal(col.type, 'OrderedCollection');
  assert.equal(col.id, `${BASE}/ap/users/muziek/posts/p-los/tracks`);
  assert.equal(col.totalItems, 3);
});

test('in de volgorde van de POST, niet van de tabel', () => {
  const col = M.buildPostTrackCollection(BASE, site, losse);
  assert.deepEqual(col.orderedItems.map((a) => a.name), ['Drie', 'Een', 'Twee'],
    'zoals iemand ze heeft neergezet is de volgorde waarin ze bedoeld zijn');
});

test('de post leent zijn titel, tekst, hoes en tags uit', () => {
  const col = M.buildPostTrackCollection(BASE, site, losse);
  assert.equal(col.name, 'Drie nieuwe nummers');
  assert.equal(col.content, 'Opgenomen op zolder, in een week.');
  assert.equal(col.image.type, 'Image');
  assert.equal(col.image.url, `${BASE}/media/hoes.jpg`);
  assert.deepEqual(col.tag.map((t) => t.name), ['#lofi', '#zolder']);
  assert.equal(col.url, `${BASE}/drie-nieuwe`);
  assert.equal(col.context, `${BASE}/ap/notes/p-los`);
});

test('en de tracks erin wijzen terug naar diezelfde post', () => {
  const col = M.buildPostTrackCollection(BASE, site, losse);
  for (const a of col.orderedItems) {
    assert.equal(a.context, `${BASE}/ap/notes/p-los`);
    assert.ok(a.url.some((u) => u.mediaType === 'text/html' && u.href === `${BASE}/drie-nieuwe`));
  }
});

test('de post wijst met een Link-tag naar zijn eigen uitgave', () => {
  const tags = M.playlistLinkTags(BASE, site, losse.content, losse);
  const link = tags.find((t) => t.href === `${BASE}/ap/users/muziek/posts/p-los/tracks`);
  assert.ok(link, 'zonder deze link bestaat de collectie wel maar vindt niemand hem');
  assert.equal(link.mediaType, 'application/activity+json');
});

test('een post zonder losse tracks heeft geen eigen uitgave', () => {
  const geen = maakPost({ id: 'p-leeg', slug: 'niets', titel: 'Niets', content: '<p>gewoon tekst</p>' });
  assert.equal(M.buildPostTrackCollection(BASE, site, geen), null);
});

test('een gesloten track telt niet mee, ook niet voor het bestaan', () => {
  maakTrack('t-dicht', 'Dicht');
  db.prepare('UPDATE audio_tracks SET fedi_open = 0 WHERE id = ?').run('t-dicht');
  const p = maakPost({ id: 'p-dicht', slug: 'dicht', titel: 'Dicht', content: '[[track:t-dicht]]' });
  assert.equal(M.buildPostTrackCollection(BASE, site, p), null,
    'geen lege collectie maar een collectie die niet bestaat');
});

// ── De playlist-collectie leent van de post die haar uitbrengt ────────────

db.prepare('INSERT INTO playlists (id, site_id, title, artist, year, kind) VALUES (?,?,?,?,?,?)')
  .run('nachtlicht', SITE, 'Nachtlicht', 'Robin', 2026, 'album');
db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)')
  .run('nachtlicht', 't-een', 0);

maakPost({
  id: 'p-plaat', slug: 'de-plaat-is-er', titel: 'De plaat is er',
  content: 'Eindelijk: [[playlist:nachtlicht]]',
  excerpt: 'Anderhalf jaar aan gewerkt.',
  cover: '/media/plaat.jpg', tags: 'album',
});

test('een playlist-collectie leent van de post die haar uitbrengt', () => {
  const pl = db.prepare('SELECT id, title, artist, year, cover_url, kind FROM playlists WHERE id = ?').get('nachtlicht');
  const col = M.buildPlaylistCollection(BASE, site, pl, M.playlistOpenTracks('nachtlicht'));
  assert.equal(col.name, 'De plaat is er', 'de posttitel wordt de titel');
  assert.equal(col.alsoKnownAs, 'Nachtlicht', 'de eigen naam gaat niet verloren');
  assert.equal(col.content, 'Anderhalf jaar aan gewerkt.');
  assert.equal(col.image.url, `${BASE}/media/plaat.jpg`);
  assert.equal(col.summary, 'Robin · 2026', 'artiest en jaar blijven de samenvatting');
  assert.equal(col.context, `${BASE}/ap/notes/p-plaat`);
});

test('een playlist zonder post leent niets', () => {
  db.prepare('INSERT INTO playlists (id, site_id, title, kind) VALUES (?,?,?,?)')
    .run('los', SITE, 'Los', 'playlist');
  const pl = db.prepare('SELECT id, title, artist, year, cover_url, kind FROM playlists WHERE id = ?').get('los');
  const col = M.buildPlaylistCollection(BASE, site, pl, []);
  assert.equal(col.name, 'Los');
  assert.equal(col.content, undefined);
  assert.equal(M.uitgavePost(SITE, 'los'), null);
});

test('twee collecties in een post: dan leent de playlist niets', () => {
  db.prepare('INSERT INTO playlists (id, site_id, title, kind) VALUES (?,?,?,?)')
    .run('tweede', SITE, 'Tweede', 'playlist');
  maakPost({
    id: 'p-twee', slug: 'twee-lijsten', titel: 'Twee lijsten',
    content: '[[playlist:tweede]] en [[playlist:nachtlicht]]',
  });
  // De post is dan geen drager van EEN identiteit meer -- dezelfde regel als in
  // de afleiding, hier alleen toegepast op de lening.
  assert.equal(M.uitgavePost(SITE, 'tweede'), null);
});
