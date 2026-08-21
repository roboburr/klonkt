// Een playlist als AP-collectie (shaer-ayc, stap 1 van het Funkwhale-spoor).
//
// Vier beloftes: de collectie bestaat op een stabiele URI; alleen fedi_open-
// tracks staan erin, met echte bestands-URL, en totalItems telt alleen die --
// wie leest kan niet aftellen wat er achter de poort staat; de volgorde is de
// playlist-volgorde, niet de invoegvolgorde; en een playlist van site A is op
// de actor van site B een 404, want tenancy loopt door alles heen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'band', 'De Band', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s2', 'ander', 'Andere Site', 'u1');

// Drie tracks: twee open, een gated. De gated staat MIDDEN in de volgorde,
// zodat een fout die hem als lege rij meetelt ook de volgorde zou breken.
const insMedia = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insTrack = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open, cover_url) VALUES (?,?,?,?,?,?,?,?)');
insMedia.run('m1', 's1', 'een.mp3', 'audio/een.mp3', 'audio/mpeg');
insMedia.run('m2', 's1', 'twee.mp3', 'audio/twee.mp3', 'audio/mpeg');
insMedia.run('m3', 's1', 'drie.mp3', 'audio/drie.mp3', 'audio/mpeg');
insTrack.run('t1', 's1', 'Opening', 'De Band', 215, 'm1', 1, '/media/hoes1.jpg');
insTrack.run('t2', 's1', 'Achter de poort', 'De Band', 180, 'm2', 0, null);
insTrack.run('t3', 's1', 'Finale', 'De Band', 240, 'm3', 1, null);

db.prepare("INSERT INTO playlists (id, site_id, title, artist, year, cover_url, kind) VALUES ('nachtlicht','s1','Nachtlicht','De Band',2026,'/media/album.jpg','album')").run();
const insPT = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)');
// Invoegvolgorde is met opzet NIET de positievolgorde.
insPT.run('nachtlicht', 't3', 3);
insPT.run('nachtlicht', 't1', 1);
insPT.run('nachtlicht', 't2', 2);

const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const getJson = async (path) => {
  const r = await fetch(base + path, { headers: { Accept: 'application/activity+json' } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null, type: r.headers.get('content-type') || '' };
};

test('de collectie bestaat, als AS2, met stabiele id en attributedTo de actor', async () => {
  const { status, body, type } = await getJson('/ap/users/band/playlists/nachtlicht');
  assert.equal(status, 200);
  assert.match(type, /application\/activity\+json/);
  assert.equal(body.type, 'OrderedCollection');
  assert.equal(body.id, 'https://test.example/ap/users/band/playlists/nachtlicht');
  assert.equal(body.attributedTo, 'https://test.example/ap/users/band');
  assert.equal(body.name, 'Nachtlicht');
  assert.equal(body.summary, 'De Band · 2026');
  assert.equal(body.icon.url, 'https://test.example/media/album.jpg');
});

test('alleen fedi_open-tracks, totalItems telt alleen die, en de poort lekt geen bestandsnaam', async () => {
  const { body } = await getJson('/ap/users/band/playlists/nachtlicht');
  assert.equal(body.totalItems, 2, 'de gated track telt niet mee');
  assert.equal(body.orderedItems.length, 2);
  const alles = JSON.stringify(body);
  assert.ok(!alles.includes('twee.mp3'), 'de gated bestandsnaam staat nergens in de collectie');
  assert.ok(!alles.includes('Achter de poort'), 'ook de titel van de gated track niet');
});

test('de volgorde is de playlist-volgorde, en elke rij is een speelbare Audio', async () => {
  const { body } = await getJson('/ap/users/band/playlists/nachtlicht');
  assert.deepEqual(body.orderedItems.map((a) => a.name), ['Opening', 'Finale']);
  for (const a of body.orderedItems) {
    assert.equal(a.type, 'Audio');
    // Sinds stap 3: een eigen id, en url als Link-array -- de mediaType hoort
    // bij de link, niet bij het object.
    assert.match(a.id, /^https:\/\/test\.example\/ap\/users\/band\/tracks\//);
    assert.ok(Array.isArray(a.url), 'url is een Link-array');
    assert.match(a.url[0].href, /^https:\/\/test\.example\/audio\/stream\//);
    assert.equal(a.url[0].mediaType, 'audio/mpeg');
  }
  assert.equal(body.orderedItems[0].duration, 'PT215S');
  assert.equal(body.orderedItems[0].summary, 'De Band');
  // Track zonder eigen hoes erft de albumhoes -- zelfde regel als post-audio,
  // waar de postcover invalt.
  assert.equal(body.orderedItems[1].icon.url, 'https://test.example/media/album.jpg');
});

test('tenancy: dezelfde playlist op de verkeerde actor is een 404', async () => {
  const { status } = await getJson('/ap/users/ander/playlists/nachtlicht');
  assert.equal(status, 404);
});

test('onbekende playlist en onbekende site zijn allebei een 404', async () => {
  assert.equal((await getJson('/ap/users/band/playlists/bestaat-niet')).status, 404);
  assert.equal((await getJson('/ap/users/niemand/playlists/nachtlicht')).status, 404);
});

test.after(() => server.close());
