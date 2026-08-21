// De RSS-feed draagt de opengezette tracks als <enclosure> (shaer-0nh).
//
// Aanleiding: de actor adverteert /feed.xml als kanaal-feed, maar die feed was
// een blogfeed -- titels en tekst, nul enclosures. Een podcast-app zoekt
// precies daarop, dus voor hem was de feed leeg hoe veel items er ook in
// stonden. De wegwijzer stond er, de inhoud niet.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const feed = (await import('../src/routes/feed.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'zanger', 'zanger@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, excerpt, content, status, published_at)
            VALUES (?,?,?,?,?,?,?,'published',?)`)
  .run('p1', 's1', 'u1', 'oud-bericht', 'Oud bericht', 'kort', '<p>x</p>', '2026-01-01T00:00:00Z');
db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, excerpt, content, status, published_at)
            VALUES (?,?,?,?,?,?,?,'published',?)`)
  .run('p2', 's1', 'u1', 'nieuw-bericht', 'Nieuw bericht', 'kort', '<p>y</p>', '2026-06-01T00:00:00Z');

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open, created_at) VALUES (?,?,?,?,?,?,?,?)');
insM.run('m1', 's1', 'open.mp3', 'audio/open.mp3', 'audio/mpeg', 4210688);
insM.run('m2', 's1', 'geheim.mp3', 'audio/geheim.mp3', 'audio/mpeg', 999);
insM.run('m3', 's1', 'tweede.mp3', 'audio/tweede.mp3', 'audio/mpeg', 1024);
insT.run('t1', 's1', 'Het open nummer', 'De Band', 203, 'm1', 1, '2026-03-01 12:00:00');
insT.run('t2', 's1', 'Achter de poort', 'De Band', 100, 'm2', 0, '2026-04-01 12:00:00');
insT.run('t3', 's1', 'Tweede open', 'De Band', 90, 'm3', 1, '2026-07-01 12:00:00');

const app = express();
app.use((req, res, next) => {
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  next();
});
app.use(feed);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const xml = await (await fetch(`http://127.0.0.1:${server.address().port}/feed.xml`)).text();

test('elke open track levert precies een enclosure', () => {
  const enclosures = xml.match(/<enclosure[^>]*>/g) || [];
  assert.equal(enclosures.length, 2, 'twee open tracks, twee enclosures');
  const items = xml.match(/<item>/g) || [];
  assert.equal(items.length, 4, 'twee posts en twee tracks, elk een eigen item');
});

test('de enclosure draagt url, lengte in bytes en het echte mime-type', () => {
  const e = (xml.match(/<enclosure[^>]*open\.mp3[^>]*>/) || [])[0];
  assert.ok(e, 'de open track heeft een enclosure');
  assert.match(e, /url="[^"]*\/audio\/stream\/open\.mp3"/);
  assert.match(e, /length="4210688"/, 'de bytes komen uit media.size');
  assert.match(e, /type="audio\/mpeg"/);
});

test('de duur staat erbij, in seconden', () => {
  assert.match(xml, /<itunes:duration>203<\/itunes:duration>/);
  assert.match(xml, /xmlns:itunes="http:\/\/www\.itunes\.com\/dtds\/podcast-1\.0\.dtd"/,
    'de namespace is gedeclareerd, anders is het geen geldige XML voor een lezer');
});

test('een gesloten track staat er niet in, en lekt titel noch bestandsnaam', () => {
  assert.ok(!xml.includes('Achter de poort'));
  assert.ok(!xml.includes('geheim.mp3'));
});

test('de guid van een track is geen permalink maar zijn AP-id', () => {
  assert.match(xml, /<guid isPermaLink="false">[^<]*\/ap\/users\/band\/tracks\/t1<\/guid>/);
});

test('posts en tracks staan door elkaar op datum, nieuwste eerst', () => {
  const titels = [...xml.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]).slice(1); // [0] is de kanaaltitel
  assert.deepEqual(titels, ['Tweede open', 'Nieuw bericht', 'Het open nummer', 'Oud bericht']);
});

test.after(() => server.close());
