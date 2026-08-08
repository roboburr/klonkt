// Onze tracks als eersterangs Audio-objecten (shaer-0nh, stap 3).
//
// De actor-collectie is de kanonieke plek: een playlist is een KEUZE daaruit.
// Een track die in geen playlist staat hoort er dus wel in, en een track die in
// twee playlists staat is twee keer HETZELFDE ding -- zelfde id.
//
// De poortregel blijft: een gesloten track is afwezig, niet leeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, cover_url, fedi_open, position) VALUES (?,?,?,?,?,?,?,?,?)');
insM.run('m1', 's1', 'open.mp3', 'audio/open.mp3', 'audio/mpeg');
insM.run('m2', 's1', 'dicht.mp3', 'audio/dicht.mp3', 'audio/mpeg');
insM.run('m3', 's1', 'los.mp3', 'audio/los.mp3', 'audio/mpeg');
insT.run('t-open', 's1', 'Open nummer', 'De Band', 203, 'm1', '/media/hoes.jpg', 1, 1);
insT.run('t-dicht', 's1', 'Gesloten nummer', 'De Band', 100, 'm2', null, 0, 2);
insT.run('t-los', 's1', 'Zonder playlist', 'De Band', 90, 'm3', null, 1, 3);

db.prepare("INSERT INTO playlists (id, site_id, title, kind, cover_url) VALUES ('plaat','s1','De Plaat','album','/media/plaathoes.jpg')").run();
db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES ('mix','s1','De Mix','playlist')").run();
const insPT = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)');
insPT.run('plaat', 't-open', 1);
insPT.run('plaat', 't-dicht', 2);
insPT.run('mix', 't-open', 1);

const app = express(); app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const haal = async (p) => {
  const r = await fetch(base + p, { headers: { Accept: 'application/activity+json' } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

test('de actor wijst naar de tracks EN de playlists, tracks eerst', async () => {
  const { body } = await haal('/ap/users/band');
  assert.deepEqual(body.streams, [
    'https://test.example/ap/users/band/tracks',
    'https://test.example/ap/users/band/playlists',
  ]);
});

test('de collectie draagt elke OPEN track, ook zonder playlist', async () => {
  const { body } = await haal('/ap/users/band/tracks');
  assert.equal(body.type, 'OrderedCollection');
  assert.equal(body.totalItems, 2, 'twee open tracks; de gesloten telt niet mee');
  const namen = body.orderedItems.map((a) => a.name);
  assert.deepEqual(namen, ['Open nummer', 'Zonder playlist'],
    'ook de track die in geen enkele playlist staat hoort hier');
  assert.ok(!JSON.stringify(body).includes('Gesloten nummer'), 'een gated titel lekt niet');
});

test('een track heeft een eigen id en url als Link-array', async () => {
  const { body } = await haal('/ap/users/band/tracks');
  const a = body.orderedItems[0];
  assert.equal(a.id, 'https://test.example/ap/users/band/tracks/t-open');
  assert.equal(a.type, 'Audio');
  assert.equal(a.attributedTo, 'https://test.example/ap/users/band');
  assert.equal(a.duration, 'PT203S');
  assert.equal(a.summary, 'De Band');
  assert.deepEqual(a.url, [{
    type: 'Link', href: 'https://test.example/audio/stream/open.mp3', mediaType: 'audio/mpeg',
  }], 'de mediaType hoort bij de link, niet bij het object');
  assert.equal(a.icon.url, 'https://test.example/media/hoes.jpg');
});

test('los op te halen, met eigen @context', async () => {
  const { status, body } = await haal('/ap/users/band/tracks/t-open');
  assert.equal(status, 200);
  assert.equal(body.id, 'https://test.example/ap/users/band/tracks/t-open');
  assert.ok(body['@context'], 'standalone draagt zijn eigen context');
});

test('een gesloten track is AFWEZIG, niet leeg', async () => {
  assert.equal((await haal('/ap/users/band/tracks/t-dicht')).status, 404);
  assert.equal((await haal('/ap/users/band/tracks/bestaatniet')).status, 404);
});

test('dezelfde track in twee playlists is HETZELFDE ding', async () => {
  const a = (await haal('/ap/users/band/playlists/plaat')).body.orderedItems[0];
  const b = (await haal('/ap/users/band/playlists/mix')).body.orderedItems[0];
  assert.equal(a.id, b.id);
  assert.equal(a.id, 'https://test.example/ap/users/band/tracks/t-open');
});

test('de playlisthoes springt in voor een track zonder eigen hoes', async () => {
  // t-los heeft geen cover_url; in de plaat-collectie zit hij niet, dus we
  // toetsen de terugval via een playlist die hem wel bevat.
  db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('plaat','t-los',3)").run();
  const items = (await haal('/ap/users/band/playlists/plaat')).body.orderedItems;
  const los = items.find((a) => a.name === 'Zonder playlist');
  assert.equal(los.icon.url, 'https://test.example/media/plaathoes.jpg');
  // En de track met een EIGEN hoes houdt die.
  assert.equal(items.find((a) => a.name === 'Open nummer').icon.url, 'https://test.example/media/hoes.jpg');
});

test.after(() => server.close());
