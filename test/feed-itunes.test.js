// De itunes-velden waaraan een podcast-app een kanaal herkent (shaer-0nh).
//
// Aanleiding: Funkwhale maakte van dev@dev.klonkt.com een kanaal en las de
// rss_url uit onze actor, maar liet content_category leeg. Die leest hij hier,
// in de feed -- niet uit `category` op de AP-actor.
//
// De categorie volgt DEZELFDE regel als op de actor: alleen Music als er ook
// werkelijk publieke muziek is. Gated telt niet mee.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const feed = (await import('../src/routes/feed.js')).default;
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare(`INSERT INTO sites (id, slug, title, tagline, author, profile_photo, owner_id, is_public, is_primary)
            VALUES (?,?,?,?,?,?,?,1,1)`)
  .run('s1', 'band', 'De Band', 'Wij maken lawaai', 'De Band zelf', '/media/avatar.webp', 'u1');
db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, excerpt, content, status, published_at)
            VALUES (?,?,?,?,?,?,?,'published',?)`)
  .run('p1', 's1', 'u1', 'bericht', 'Bericht', 'kort', '<p>x</p>', '2026-01-01T00:00:00Z');

const app = express();
app.use((req, res, next) => {
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  next();
});
app.use(feed);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const haal = async () => (await fetch(`http://127.0.0.1:${server.address().port}/feed.xml`)).text();

const site = () => db.prepare("SELECT * FROM sites WHERE id = 's1'").get();

test('zonder publieke muziek: wel auteur, samenvatting en plaat, GEEN categorie', async () => {
  const xml = await haal();
  assert.match(xml, /<itunes:author>De Band zelf<\/itunes:author>/);
  assert.match(xml, /<itunes:summary>Wij maken lawaai<\/itunes:summary>/);
  assert.match(xml, /<itunes:image href="[^"]*\/media\/avatar\.webp" \/>/, 'de plaat wordt absoluut gemaakt');
  assert.ok(!xml.includes('<itunes:category'), 'een blog zonder open track is geen muziekkanaal');
  assert.equal(AP.channelCategory(site()), null, 'en de actor zegt hetzelfde');
});

test('een GATED track maakt er nog geen muziekkanaal van', async () => {
  db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)')
    .run('m0', 's1', 'dicht.mp3', 'audio/dicht.mp3', 'audio/mpeg', 10);
  db.prepare('INSERT INTO audio_tracks (id, site_id, title, media_id, fedi_open) VALUES (?,?,?,?,0)')
    .run('t0', 's1', 'Achter de poort', 'm0');
  const xml = await haal();
  assert.ok(!xml.includes('<itunes:category'), 'afwezig is afwezig, ook in een categorie');
  assert.equal(AP.channelCategory(site()), null);
  assert.ok(!xml.includes('Achter de poort'));
});

test('met een OPEN track wordt het Music, aan beide kanten', async () => {
  db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)')
    .run('m1', 's1', 'open.mp3', 'audio/open.mp3', 'audio/mpeg', 4210688);
  db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, cover_url, fedi_open, created_at) VALUES (?,?,?,?,?,?,?,1,?)')
    .run('t1', 's1', 'Het nummer', 'De Band', 203, 'm1', '/media/hoes.jpg', '2026-03-01 12:00:00');
  const xml = await haal();
  assert.match(xml, /<itunes:category text="Music" \/>/);
  assert.equal(AP.channelCategory(site()), 'music');
});

test('een track draagt zijn eigen artiest en hoes mee', async () => {
  const xml = await haal();
  assert.match(xml, /<itunes:author>De Band<\/itunes:author>/, 'de artiest van de track, naast die van het kanaal');
  assert.match(xml, /<itunes:image href="[^"]*\/media\/hoes\.jpg" \/>/);
  assert.match(xml, /<itunes:duration>203<\/itunes:duration>/);
});

test.after(() => server.close());
