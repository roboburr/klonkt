// De poort van de buurman (shaer-ayc, gevonden 7 augustus).
//
// setAudioFediOpen opent de tracks van een post op drie manieren: [[track:id]],
// [[album:naam]] en [[playlist:id]]. De eerste twee filterden al op site_id, de
// playlist-tak niet -- en playlists.id is een GLOBALE sleutel (slug-stijl, bv.
// 'ai-covers'). Een post op site A met de playlist van site B zette daarmee de
// bestanden van B open. En fedi_open is EENRICHTINGS (nooit terug naar 0, zie
// de noot boven de functie), dus dat was geen vergissing die je terugdraait.
//
// Het filter hoort op de TRACKS, niet op de playlist: een playlist van je eigen
// site kan een vreemde track bevatten, en ook dan is het bestand niet van jou.
// De laatste test hieronder bewaakt precies dat verschil.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
// Houd wat de routes bij import aanmaken buiten de checkout.
process.env.MEDIA_PATH = path.join(os.tmpdir(), 'klonkt-test-media');

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const routes = (await import('../src/routes/posts.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s1', 'band', 'De Band', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)')
  .run('s2', 'ander', 'Andere Site', 'u1');

const insMedia = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insTrack = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open) VALUES (?,?,?,?,?,?,0)');
// Site A heeft een eigen track, site B er drie. Alles staat dicht.
insMedia.run('ma1', 's1', 'eigen.mp3', 'audio/eigen.mp3', 'audio/mpeg');
insMedia.run('mb1', 's2', 'b-een.mp3', 'audio/b-een.mp3', 'audio/mpeg');
insMedia.run('mb2', 's2', 'b-twee.mp3', 'audio/b-twee.mp3', 'audio/mpeg');
insMedia.run('mb3', 's2', 'b-drie.mp3', 'audio/b-drie.mp3', 'audio/mpeg');
insTrack.run('ta1', 's1', 'Van mij', 'De Band', 200, 'ma1');
insTrack.run('tb1', 's2', 'Van de buurman', 'Andere', 210, 'mb1');
insTrack.run('tb2', 's2', 'Ook van de buurman', 'Andere', 220, 'mb2');
insTrack.run('tb3', 's2', 'Gesmokkeld', 'Andere', 230, 'mb3');

const insPl = db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES (?,?,?,'album')");
const insPT = db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,?)');
insPl.run('ai-covers', 's2', 'AI Covers');   // playlist VAN SITE B
insPT.run('ai-covers', 'tb1', 1);
insPT.run('ai-covers', 'tb2', 2);
insPl.run('eigen', 's1', 'Eigen Werk');      // playlist van site A ...
insPT.run('eigen', 'ta1', 1);
insPT.run('eigen', 'tb3', 2);                // ... met een vreemde track erin

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.session = { user: db.prepare('SELECT * FROM users WHERE id = ?').get('u1') };
  res.locals.site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1'); // we posten ALS SITE A
  res.locals.siteUrlBase = '';
  next();
});
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const open = (id) => db.prepare('SELECT fedi_open FROM audio_tracks WHERE id = ?').get(id).fedi_open;

// Een post op site A die BEIDE playlists insluit, met de deel-op-fedi-vinkje aan.
const res = await fetch(`${base}/posts/create`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  redirect: 'manual',
  body: new URLSearchParams({
    title: 'Luister dit',
    status: 'draft',                    // draft: geen federatie, wel de fedi_open-stap
    content: '<p>[[playlist:eigen]] [[playlist:ai-covers]]</p>',
    fedi_open_audio: '1',
  }),
});

test('de post is echt aangemaakt', () => {
  // Zonder deze test is de rest vals groen: een 403 of 400 laat alles op 0 staan
  // en dan slaagt een "blijft dicht"-bewering zonder dat er iets gebeurd is.
  assert.equal(res.status, 302, `verwacht een redirect na opslaan, kreeg ${res.status}`);
  const post = db.prepare('SELECT content FROM posts WHERE site_id = ? AND slug = ?').get('s1', 'luister-dit');
  assert.ok(post, 'de post staat in de database');
  assert.match(post.content, /\[\[playlist:ai-covers\]\]/, 'de shortcode overleeft de sanitizer');
});

test('de eigen track van de post gaat wel open', () => {
  // De vangrail onder de test hierna: het filter mag de functie niet slopen.
  assert.equal(open('ta1'), 1, 'site A opent zijn eigen track via zijn eigen playlist');
});

test('de tracks van de playlist van een ANDERE site blijven dicht', () => {
  assert.equal(open('tb1'), 0, 'een post op site A opent geen bestand van site B');
  assert.equal(open('tb2'), 0);
});

test('ook een vreemde track in je EIGEN playlist blijft dicht', () => {
  // Hier zou een check op playlists.site_id niets tegen doen -- de playlist is
  // immers van site A. Het bestand is dat niet, en dat is wat de poort bewaakt.
  assert.equal(open('tb3'), 0);
});

test.after(() => server.close());
