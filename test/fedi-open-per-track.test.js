// Fedi open per track, vanuit de mediamanager (Robin, 30-9).
//
// De vlag was altijd al per track (audio_tracks.fedi_open), maar aanzetten kon
// alleen per POST, met het vinkje in de editor. Nu ook per track. Wat hier
// bewaakt wordt:
//
//   1. openen zet de vlag en stuurt een Update voor ELKE gepubliceerde post van
//      deze site waar de track in staat -- rechtstreeks, via album, via playlist.
//      Anders krijgt een volger de speler pas bij de volgende bewerking.
//   2. EENRICHTINGS: er is geen weg terug, ook niet via de algemene bijwerk-API.
//   3. alleen een track met een eigen bestand, en alleen van deze site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
process.env.MEDIA_PATH = path.join(os.tmpdir(), 'klonkt-test-media');

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const audioMod = await import('../src/routes/admin-audio.js');
const { openTrackOnFediverse } = audioMod;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)').run('s1', 'band', 'De Band', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES (?,?,?,?,1)').run('s2', 'ander', 'Andere', 'u1');
const site = (id) => db.prepare('SELECT * FROM sites WHERE id = ?').get(id);

const insMedia = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,1000)');
const insTrack = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, album, duration, media_id, fedi_open) VALUES (?,?,?,?,?,?,?,0)');
insMedia.run('m1', 's1', 'zwaluwen.mp3', 'audio/zwaluwen.mp3', 'audio/mpeg');
insMedia.run('m2', 's1', 'stil.mp3', 'audio/stil.mp3', 'audio/mpeg');
insMedia.run('mb', 's2', 'buur.mp3', 'audio/buur.mp3', 'audio/mpeg');
insTrack.run('ta1', 's1', 'Zwaluwen', 'De Band', 'Voorjaar', 200, 'm1');
insTrack.run('ta3', 's1', 'Stil', 'De Band', null, 90, 'm2');       // hangt in geen enkele post
insTrack.run('link', 's1', 'Alleen een link', 'De Band', null, 0, null);
insTrack.run('tb1', 's2', 'Van de buurman', 'Andere', null, 210, 'mb');

db.prepare('INSERT INTO playlists (id, site_id, title) VALUES (?,?,?)').run('pl1', 's1', 'Lente');
db.prepare('INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES (?,?,0)').run('pl1', 'ta1');

const insPost = db.prepare('INSERT INTO posts (id, site_id, slug, title, content, status, author_id) VALUES (?,?,?,?,?,?,?)');
insPost.run('p-direct', 's1', 'direct', 'Direct', 'Luister: [[track:ta1]]', 'published', 'u1');
insPost.run('p-album', 's1', 'album', 'Album', '[[album:Voorjaar]]', 'published', 'u1');
insPost.run('p-playlist', 's1', 'lijst', 'Lijst', '[[playlist:pl1]]', 'published', 'u1');
insPost.run('p-concept', 's1', 'concept', 'Concept', '[[track:ta1]]', 'draft', 'u1');
insPost.run('p-anders', 's1', 'anders', 'Anders', 'Geen muziek', 'published', 'u1');
// Een post op een ANDERE site met het id van onze track: die is niet van ons.
insPost.run('q-buur', 's2', 'buur', 'Buur', '[[track:ta1]]', 'published', 'u1');

const open = (id) => db.prepare('SELECT fedi_open FROM audio_tracks WHERE id = ?').get(id).fedi_open;

const { postsEmbeddingTrack } = await import('../src/services/music/index.js');

test('de posts met een track: direct, via album, via playlist, en alleen van deze site', () => {
  // Rechtstreeks getoetst, en niet alleen via het openen: daar vangt een tweede
  // controle (post opnieuw ophalen met site_id) een fout hier nog op, maar deze
  // functie is los te gebruiken, en een volgende aanroeper heeft die tweede
  // wacht misschien niet.
  assert.deepEqual(postsEmbeddingTrack('s1', 'ta1').sort(), ['p-album', 'p-direct', 'p-playlist']);
  assert.deepEqual(postsEmbeddingTrack('s2', 'ta1'), [], 'een track van een andere site hoort bij niemand hier');
});

test('openen zet de vlag en stuurt elke post met de track opnieuw de deur uit', async () => {
  const verstuurd = [];
  const uit = openTrackOnFediverse(site('s1'), 'ta1', { deliver: (s, p) => { verstuurd.push(p.id); } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(uit.ok, true);
  assert.equal(uit.changed, true);
  assert.equal(open('ta1'), 1);
  assert.deepEqual(verstuurd.sort(), ['p-album', 'p-direct', 'p-playlist'],
    'direct, via album en via playlist; geen concept, geen post zonder de track, geen post van een andere site');
});

test('nog een keer openen verandert niets en verstuurt niets', async () => {
  const verstuurd = [];
  const uit = openTrackOnFediverse(site('s1'), 'ta1', { deliver: (s, p) => { verstuurd.push(p.id); } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(uit.changed, false);
  assert.deepEqual(verstuurd, []);
});

test('een track die alleen een link is, heeft niets om te openen', () => {
  const uit = openTrackOnFediverse(site('s1'), 'link', { deliver: () => {} });
  assert.deepEqual([uit.ok, uit.reason], [false, 'no_file']);
  assert.equal(open('link'), 0);
});

test('de track van een andere site blijft dicht', () => {
  const uit = openTrackOnFediverse(site('s1'), 'tb1', { deliver: () => {} });
  assert.deepEqual([uit.ok, uit.reason], [false, 'not_found']);
  assert.equal(open('tb1'), 0, 'fedi_open is eenrichtings: een verkeerd geopend bestand haal je niet terug');
});

// ── Via de routes ────────────────────────────────────────────────────────────
const express = (await import('express')).default;
const app = express();
app.use((req, res, next) => {
  res.locals.site = site('s1');
  res.locals.siteUrlBase = '';
  req.session = { user: { id: 'u1', role: 'god', username: 'u1' } };
  next();
});
app.use('/admin/audio', audioMod.default);
const server = app.listen(0);
server.unref();
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test('de knop in de mediamanager opent de track', async () => {
  const r = await fetch(`${base}/admin/audio/ta3/fedi-open`, { method: 'POST', redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location') || '', /^\/admin\/audio\?success=/);
  assert.equal(open('ta3'), 1);
});

test('er is geen weg terug, ook niet via de algemene bijwerk-API', async () => {
  const r = await fetch(`${base}/admin/audio/api/ta1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fedi_open: false }),
  });
  assert.notEqual(r.status, 200, 'de API neemt fedi_open niet aan');
  assert.equal(open('ta1'), 1, 'en de track blijft open');
});

test('de lijst biedt openen alleen aan waar het kan', async () => {
  const html = await (await fetch(`${base}/admin/audio`)).text();
  assert.ok(!html.includes('/admin/audio/link/fedi-open'), 'een link-track krijgt geen knop');
  assert.ok(!html.includes('/admin/audio/ta1/fedi-open'), 'een open track krijgt geen knop meer, alleen het slotje');
  assert.ok(html.includes('ax-fedi-on'), 'het slotje staat er wel');
});

test('een dichte track met een bestand krijgt de knop, met bevestiging', async () => {
  insMedia.run('m4', 's1', 'nieuw.mp3', 'audio/nieuw.mp3', 'audio/mpeg');
  insTrack.run('ta4', 's1', 'Nieuw', 'De Band', null, 120, 'm4');
  const html = await (await fetch(`${base}/admin/audio`)).text();
  const i = html.indexOf('action="/admin/audio/ta4/fedi-open"');
  assert.ok(i >= 0, 'de knop hoort er te staan');
  assert.ok(html.slice(i, i + 400).includes('data-confirm='), 'en eerst te vragen, want terug kan niet');
});
