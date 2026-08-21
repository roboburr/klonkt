// De omslag van een speler-post (Barts melding, 7-8).
//
// Een post met gehoste audio of een externe embed laat zijn omslag BEWUST uit
// `attachment` vallen: Mastodon toont media OF een kaart, nooit allebei, en
// voor zo'n post willen we de kaart. De omslag verhuist dan naar het AS2-veld
// `image` van de Note.
//
// Dat is een CONTRACT, want er hangen twee lezers aan: handleInbox tilt hem er
// weer uit voor binnenkomende posts, en sinds vandaag doet Shaer hetzelfde voor
// je eigen posts van de outbox. Zonder deze test kan `image` stil verdwijnen en
// wordt een muzieksite in beide clients een muur van kale kaartjes -- precies
// het beeld waarmee dit begon.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const BASE = 'https://test.example';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'demo', 'Demo', 'u1', 1);
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
site.primary_slug = 'demo';

db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
  .run('m1', 's1', 'song.mp3', 'audio/mpeg', 1000, '/x/song.mp3');
// fedi_open = 0: de standaard, en juist die post verliest zijn omslag zonder
// er een speler voor terug te krijgen.
db.prepare('INSERT INTO audio_tracks (id, site_id, title, media_id, fedi_open) VALUES (?,?,?,?,?)')
  .run('t1', 's1', 'Gesloten track', 'm1', 0);

const post = (over) => ({ id: 'p', slug: 'p', title: '', content: '<p>x</p>', tags: '[]',
  cover_image_url: '/media/cover.webp', cover_alt: 'De hoes', created_at: '2026-01-01T00:00:00Z', ...over });
const images = (n) => (n.attachment || []).filter((a) => /^image\//.test(a.mediaType || ''));

test('een gehoste-audio post ruilt zijn omslag-bijlage in voor image', () => {
  const n = AP.buildNote(BASE, site, post({ content: '<p>[[track:t1]]</p>' }));
  assert.equal(images(n).length, 0, 'geen afbeeldingsbijlage');
  assert.ok(n.image, 'omslag staat in image');
  assert.equal(n.image.url, `${BASE}/media/cover.webp`);
  assert.equal(n.image.name, 'De hoes', 'de alt-tekst gaat mee');
});

test('een externe embed doet hetzelfde', () => {
  const n = AP.buildNote(BASE, site, post({ content: '<p>Luister: https://open.spotify.com/track/abc</p>' }));
  assert.equal(images(n).length, 0);
  assert.equal(n.image && n.image.url, `${BASE}/media/cover.webp`);
});

test('een gewone post houdt zijn omslag als bijlage en krijgt GEEN image', () => {
  // Anders zou elke fotopost in de clients een tweede, identieke omslag tonen.
  const n = AP.buildNote(BASE, site, post());
  assert.equal(images(n).length, 1);
  assert.equal(images(n)[0].url, `${BASE}/media/cover.webp`);
  assert.ok(!n.image, 'image blijft leeg');
});

test('zonder omslag valt er niets te verhuizen', () => {
  const n = AP.buildNote(BASE, site, post({ content: '<p>[[track:t1]]</p>', cover_image_url: null }));
  assert.ok(!n.image);
});
