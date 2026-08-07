// Vindbaarheid van playlist-collecties (shaer-ayc, stap 2).
//
// Drie wegen ernaartoe, elk getest: de actor wijst via AS2 `streams` naar de
// lijst; de lijst geeft kaal URI's en verrijkt stubs (FEP-9876), waarbij ook
// een stub alleen het open deel telt; en een post die een playlist insluit
// draagt een Link-tag naar de collectie -- maar nooit naar die van een andere
// site, want playlist-ids zijn een globale primary key.
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
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'band', 'De Band', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s2', 'ander', 'Andere Site', 'u1');

const insMedia = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insTrack = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open) VALUES (?,?,?,?,?,?,?)');
insMedia.run('m1', 's1', 'een.mp3', 'audio/een.mp3', 'audio/mpeg');
insMedia.run('m2', 's1', 'twee.mp3', 'audio/twee.mp3', 'audio/mpeg');
insTrack.run('t1', 's1', 'Open nummer', 'De Band', 200, 'm1', 1);
insTrack.run('t2', 's1', 'Dicht nummer', 'De Band', 180, 'm2', 0);

// Twee playlists op band, een op ander. Expliciete created_at: de lijst
// sorteert erop, en twee inserts in dezelfde seconde maken die volgorde
// anders een muntworp.
db.prepare("INSERT INTO playlists (id, site_id, title, kind, created_at) VALUES ('eerste','s1','Eerste Plaat','album','2026-01-01 00:00:00')").run();
db.prepare("INSERT INTO playlists (id, site_id, title, kind, created_at) VALUES ('tweede','s1','Tweede Plaat','album','2026-02-01 00:00:00')").run();
db.prepare("INSERT INTO playlists (id, site_id, title, kind, created_at) VALUES ('vreemd','s2','Van De Ander','album','2026-03-01 00:00:00')").run();
const insPT = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)');
insPT.run('eerste', 't1', 1);
insPT.run('eerste', 't2', 2);

const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const getJson = async (path, headers = {}) => {
  const r = await fetch(base + path, { headers: { Accept: 'application/activity+json', ...headers } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null, headers: r.headers };
};

test('de actor wijst via streams naar de playlist-lijst', async () => {
  const { body } = await getJson('/ap/users/band');
  assert.deepEqual(body.streams, ['https://test.example/ap/users/band/playlists']);
});

test('de lijst is kaal standaard: URI-per-playlist, alleen van deze site, in vaste volgorde', async () => {
  const { body } = await getJson('/ap/users/band/playlists');
  assert.equal(body.type, 'OrderedCollection');
  assert.equal(body.totalItems, 2);
  assert.deepEqual(body.orderedItems, [
    'https://test.example/ap/users/band/playlists/eerste',
    'https://test.example/ap/users/band/playlists/tweede',
  ]);
});

test('verrijkt (FEP-9876) geeft stubs zonder tracks, en ook de stub telt alleen het open deel', async () => {
  const { body, headers } = await getJson('/ap/users/band/playlists', { Prefer: 'return=representation' });
  assert.equal(headers.get('preference-applied'), 'return=representation');
  assert.match(headers.get('vary') || '', /Prefer/);
  const stub = body.orderedItems[0];
  assert.equal(stub.name, 'Eerste Plaat');
  assert.equal(stub.totalItems, 1, 'een open en een gated track: de stub telt er een');
  assert.equal(stub.orderedItems, undefined, 'een stub draagt geen tracks');
  assert.equal(stub['@context'], undefined, 'genest object draagt de context van zijn omhulsel');
  assert.ok(!JSON.stringify(body).includes('Dicht nummer'), 'de gated titel lekt ook hier niet');
});

test('een lege site heeft een lege lijst, geen 404 -- de lijst zelf is niet geheim', async () => {
  const { status, body } = await getJson('/ap/users/ander/playlists');
  assert.equal(status, 200);
  assert.equal(body.totalItems, 1); // de eigen playlist van s2 staat er wel in
});

test('een post met [[playlist:id]] draagt een Link-tag naar de collectie', () => {
  const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const post = { id: 'p1', slug: 'p1', title: 'Luister', content: 'Nieuw album! [[playlist:eerste]] en nogmaals [[playlist:eerste]]', status: 'published' };
  const note = AP.buildNote('https://test.example', site, post);
  const links = (note.tag || []).filter((t) => t.type === 'Link');
  assert.equal(links.length, 1, 'dubbel insluiten geeft een tag');
  assert.equal(links[0].href, 'https://test.example/ap/users/band/playlists/eerste');
  assert.equal(links[0].name, 'Eerste Plaat');
});

test('een playlist van een ANDERE site levert geen tag -- de site-check is de tenancy-grens', () => {
  const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const post = { id: 'p2', slug: 'p2', title: 'Fout', content: 'Kijk: [[playlist:vreemd]]', status: 'published' };
  const note = AP.buildNote('https://test.example', site, post);
  assert.equal((note.tag || []).filter((t) => t.type === 'Link').length, 0);
});

test('een post zonder playlist heeft geen Link-tags', () => {
  const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const note = AP.buildNote('https://test.example', site, { id: 'p3', slug: 'p3', title: 'Los', content: 'Gewoon tekst met [[track:t1]]', status: 'published' });
  assert.equal((note.tag || []).filter((t) => t.type === 'Link').length, 0);
});

test.after(() => server.close());
