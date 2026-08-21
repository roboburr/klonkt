// Onze Audio inhoudelijk gelijk aan die van Funkwhale (shaer-0nh).
//
// Vergelijking van dezelfde track aan beide kanten leerde: op elk veld waar AS2
// iets zegt zijn WIJ conform en zij niet -- en dat is precies een veld,
// duration. Al hun extra velden bestaan gewoon in schema.org, dat Klonkt al in
// zijn context had. Dus we konden ze alle vier overnemen zonder concessie: de
// SLEUTELS zijn die van Funkwhale, de BETEKENIS komt van schema.org.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)')
  .run('m1', 's1', 'nummer.mp3', 'audio/nummer.mp3', 'audio/mpeg', 1653698);
db.prepare(`INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, cover_url, position, license, fedi_open, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
  .run('t1', 's1', '0METAL MARIO', 'De Band', 103, 'm1', '/media/hoes.jpg', 1, 'CC BY 4.0', '2026-08-08 04:38:34');

const track = () => AP.siteOpenTracks('s1')[0];
const audio = () => AP.buildTrackAudio(BASE, { slug: 'band' }, track());

test('de bestandsgegevens zitten op de LINK, niet op het object', () => {
  const a = audio();
  assert.equal(a.url.length, 1);
  assert.equal(a.url[0].size, 1653698, 'bytes horen bij deze representatie');
  assert.equal(a.url[0].bitrate, Math.round((1653698 * 8) / 103), 'afgeleid uit bytes en seconden, niet gegokt');
  assert.equal(a.size, undefined, 'het NUMMER is geen bestand');
  assert.equal(a.bitrate, undefined);
});

test('to staat op het object zelf, niet alleen op de Create', () => {
  assert.deepEqual(audio().to, ['https://www.w3.org/ns/activitystreams#Public'],
    'een los opgehaalde track moet zelf kunnen zeggen dat hij openbaar is');
});

test('position en license komen mee', () => {
  const a = audio();
  assert.equal(a.position, 1);
  assert.equal(a.license, 'http://creativecommons.org/licenses/by/4.0/', 'de tekst uit onze keuzelijst wordt de canonieke URI');
});

test('de hoes staat onder icon EN image -- allebei AS2-kern', () => {
  const a = audio();
  assert.equal(a.icon.url, 'https://test.example/media/hoes.jpg');
  assert.deepEqual(a.image, a.icon, 'dezelfde hoes, twee namen; wij lazen icon, Funkwhale leest image');
});

test('duration blijft de spec volgen -- daar wijken we bewust af van Funkwhale', () => {
  // AS2 zegt MUST xsd:duration, schema.org zegt ISO 8601. Funkwhale stuurt een
  // getal. Op dit ene veld hebben wij gelijk, dus hier bewegen we niet.
  assert.equal(audio().duration, 'PT103S');
});

test('een licentie die we niet kennen levert GEEN veld op', () => {
  db.prepare("UPDATE audio_tracks SET license = 'Alle rechten voorbehouden' WHERE id = 't1'").run();
  assert.equal(audio().license, undefined, 'een zelfbedachte licentie-URI is erger dan geen: een lezer gelooft hem');
  db.prepare("UPDATE audio_tracks SET license = 'https://voorbeeld.example/licentie' WHERE id = 't1'").run();
  assert.equal(audio().license, 'https://voorbeeld.example/licentie', 'een ingevulde URI gaat wel door');
  db.prepare("UPDATE audio_tracks SET license = 'CC BY 4.0' WHERE id = 't1'").run();
});

test('zonder duur of grootte geen verzonnen bitrate', () => {
  // media.size is NOT NULL, dus 0 als "onbekend" -- dat is ook wat de kolom in
  // de praktijk krijgt als de grootte niet bepaald kon worden.
  db.prepare("UPDATE media SET size = 0 WHERE id = 'm1'").run();
  const a = audio();
  assert.equal(a.url[0].bitrate, undefined);
  assert.equal(a.url[0].size, undefined);
  assert.equal(a.duration, 'PT103S', 'de duur staat er nog wel');
  db.prepare('UPDATE media SET size = 1653698 WHERE id = ?').run('m1');
});
