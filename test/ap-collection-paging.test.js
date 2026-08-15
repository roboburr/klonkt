// Wie `first` belooft, moet een PAGINA leveren (open.audio, 15-8).
//
// De aanleiding: `/ap/users/dev/library` gaf 200, keurig met `first` en `last`,
// maar `?page=1` gaf de bibliotheek OPNIEUW -- zelfde id, type Library, en een
// `first` die weer naar zichzelf wees. open.audio volgde die verwijzing en gaf
// een 500 terug op onze URL.
//
// De bouwer kon al pagineren; de ROUTE gaf `?page=` niet door. Daarom loopt deze
// test over HTTP en niet over `buildLibrary()`: een unit-test op de bouwer stond
// er al en was groen, precies terwijl het gat openstond. Zie
// [verificatie-niet-zonder-slaagtest] -- een controle die niet kan falen op wat
// je verandert is geen bewijs.
//
// Hij is bewust een LUS over alle collecties en geen rijtje losse gevallen: het
// gat ontstond doordat vier routes de doorgifte wel hadden en twee niet, en een
// per-collectie-test vraagt om precies diezelfde vergeetachtigheid.
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
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open, position) VALUES (?,?,?,?,?,?,1,?)');
for (const n of [1, 2, 3]) {
  insM.run(`m${n}`, 's1', `t${n}.mp3`, `audio/t${n}.mp3`, 'audio/mpeg');
  insT.run(`t${n}`, 's1', `Nummer ${n}`, 'De Band', 120, `m${n}`, n);
}
db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES ('plaat','s1','De Plaat','album')").run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('plaat','t1',1)").run();
db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
            VALUES ('p1','s1','u1','hallo','Hallo','<p>x</p>','published','2026-08-01T00:00:00Z')`).run();

const app = express(); app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const haal = async (pad) => {
  const r = await fetch(base + pad, { headers: { Accept: 'application/activity+json' } });
  return { status: r.status, body: r.status === 200 ? await r.json() : null };
};

// Elke collectie die een actor of een object naar buiten adverteert.
const COLLECTIES = [
  '/ap/users/band/outbox',
  '/ap/users/band/followers',
  '/ap/users/band/following',
  '/ap/users/band/featured',
  '/ap/users/band/tracks',
  '/ap/users/band/playlists',
  '/ap/users/band/library',
  '/ap/users/band/library/followers',
];

for (const pad of COLLECTIES) {
  test(`${pad}: first wijst naar een echte pagina`, async () => {
    const wortel = await haal(pad);
    assert.equal(wortel.status, 200, `${pad} gaf ${wortel.status}`);

    // Geen `first`? Dan belooft hij ook niets en valt er niets te controleren.
    if (!wortel.body.first) return;

    const eerste = typeof wortel.body.first === 'string' ? wortel.body.first : wortel.body.first.id;
    assert.ok(eerste, `${pad}: first zonder id`);

    const pagina = await haal(new URL(eerste).pathname + new URL(eerste).search);
    assert.equal(pagina.status, 200, `${pad}: first gaf ${pagina.status}`);

    // DE KERN: de pagina moet een pagina zijn en niet de collectie opnieuw.
    assert.match(pagina.body.type, /Page$/, `${pad}: first gaf type ${pagina.body.type}`);
    assert.equal(pagina.body.partOf, wortel.body.id, `${pad}: pagina hoort niet bij de collectie`);
    assert.notEqual(pagina.body.id, wortel.body.id, `${pad}: pagina deelt zijn id met de collectie`);

    // Een pagina MAG `first` dragen (AS2: CollectionPage erft van Collection,
    // en Funkwhale eist het zelfs op library-pagina's). Wat niet mag is een
    // `next` naar zichzelf: dat is de lus, en die zit in de verwijzing die een
    // lezer volgt, niet in de aanwezigheid van het veld.
    assert.notEqual(pagina.body.next, eerste, `${pad}: next wijst naar de pagina zelf`);

    // De items horen bij het type: geordend -> orderedItems, ongeordend ->
    // items. Een `Collection` met `orderedItems` is voor een strikte lezer leeg.
    const sleutel = pagina.body.type === 'CollectionPage' ? 'items' : 'orderedItems';
    assert.ok(Array.isArray(pagina.body[sleutel]), `${pad}: ${pagina.body.type} zonder ${sleutel}`);
  });
}

test.after(() => server.close());
