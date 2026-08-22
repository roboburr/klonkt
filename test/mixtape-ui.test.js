// De mixtape als POSTTYPE: kiesbaar, opslaanbaar, en zichzelf noemend.
//
// De waarschuwing staat al in config/post-types.js en is hier het hele punt:
// kent de opslag een type niet, dan wordt de post ZONDER MELDING een gewone
// post. De keuze verdwijnt dan in plaats van geweigerd te worden, en niemand
// ziet het tot een post van soort blijkt te zijn veranderd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();

const { KEUZE_TYPES, POST_TYPES, MUZIEK_TYPES } = await import('../src/config/post-types.js');

test('mixtape is een kiesbaar type, en draagt muziek', () => {
  assert.ok(KEUZE_TYPES.includes('mixtape'), 'anders staat de knop er niet');
  assert.ok(POST_TYPES.has('mixtape'), 'anders gooit het opslaan hem stil weg');
  assert.ok(MUZIEK_TYPES.has('mixtape'), 'anders deelt hij het muziekpaneel niet');
});

test('de composer toont de knop en deelt het muziekpaneel', () => {
  const ejsBron = fs.readFileSync('src/views/pages/post-edit.ejs', 'utf8');
  assert.match(ejsBron, /mixtape: '📼'/, 'een eigen teken, niet dat van een album');
  assert.match(ejsBron, /data-panel="album playlist mixtape audio"/,
    'zonder mixtape in deze lijst verdwijnt het uploadpaneel zodra je het type kiest');
});

test('het type mag meeveranderen met de muziek', () => {
  const mod = fs.readFileSync('src/assets/js/mod/post-edit.js', 'utf8');
  assert.match(mod, /VOLGBAAR = new Set\(\[[^\]]*'mixtape'/,
    'anders blijft het type op post staan als je een mixtape invoegt');
  // De opzoeker van de editor moet dezelfde soorten kennen als de server, anders
  // ziet het scherm album terwijl de server mixtape opslaat.
  assert.doesNotMatch(mod, /kindVan\.set\(p\.id, p\.kind === 'playlist'/,
    'de binaire vorm hoort weg te zijn');
});

test('een post van type mixtape houdt zijn type bij het opslaan', async () => {
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'baas', 'b@t.nl', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'robo', 'Soundfabrics', 'u1');

  const express = (await import('express')).default;
  const router = (await import('../src/routes/posts.js')).default;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { user: { id: 'u1', role: 'god', username: 'baas' } };
    res.locals.site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('robo');
    res.locals.siteUrlBase = '';
    next();
  });
  app.use('/', router);
  const server = app.listen(0);
  server.unref();

  const r = await fetch(`http://127.0.0.1:${server.address().port}/posts/create`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      title: 'De Mixtape', content: '<p>kant A</p>', type: 'mixtape', status: 'published',
    }).toString(),
    signal: AbortSignal.timeout(5000),
  }).catch((e) => assert.fail(`de route antwoordde niet (${e.name})`));
  assert.ok(r.status === 302 || r.status === 200, 'opslaan mag niet stranden, kreeg ' + r.status);

  const post = db.prepare("SELECT type FROM posts WHERE title = ?").get('De Mixtape');
  assert.ok(post, 'de post hoort te bestaan');
  assert.equal(post.type, 'mixtape', 'het type mag niet stil terugvallen op post');
  server.close();
});

test('een ingesloten mixtape noemt zich mixtape en geen album', async () => {
  const AudioEmbedService = (await import('../src/services/AudioEmbedService.js')).default;
  const pl = {
    id: 'tape', title: 'De Mixtape', artist: 'robo', kind: 'mixtape',
    tracks: [{ id: 't1', title: 'Kant A', artist: 'robo', url: '/a.mp3', duration: 100, cover: '' }],
  };
  // Door de ECHTE weg: de shortcode in de tekst, uitgeklapt zoals bij het tonen
  // van een post. De vorige versie van deze test riep een methode aan die niet
  // bestaat en sloeg zichzelf dan over -- groen zonder iets te meten.
  const html = AudioEmbedService.embedPlaylistShortcodes('<p>[[playlist:tape]]</p>', (id) => (id === 'tape' ? pl : null));
  assert.match(html, /📼 Mixtape/, 'een mixtape hoort zichzelf zo te noemen');
  assert.doesNotMatch(html, /💿 Album/, 'en niet het jasje van een album te dragen');
});

test('de renderer kiest zijn label niet meer met een tweewegkeuze', () => {
  const bron = fs.readFileSync('src/services/AudioEmbedService.js', 'utf8');
  assert.doesNotMatch(bron, /kind === 'playlist' \? '📃 Playlist' : '💿 Album'/,
    'die vorm gaf een mixtape het jasje van een album');
  assert.match(bron, /mixtape: '📼 Mixtape'/);
});

test('het bandje is een cassette, geen albumlijst', async () => {
  const AudioEmbedService = (await import('../src/services/AudioEmbedService.js')).default;
  const pl = {
    id: 'tape', title: 'De Mixtape', artist: 'robo', kind: 'mixtape', cover: '',
    tracks: [
      { id: 't1', title: 'Kant A', artist: 'robo', url: '/a.mp3', duration: 100, cover: '' },
      { id: 't2', title: 'Kant B', artist: 'robo', url: '/b.mp3', duration: 44, cover: '' },
    ],
  };
  const html = AudioEmbedService.embedPlaylistShortcodes('<p>[[playlist:tape]]</p>', (id) => (id === 'tape' ? pl : null));

  assert.match(html, /class="post-tape"/);
  assert.match(html, /tape-reel--left/, 'twee spoelen, anders is het geen cassette');
  assert.match(html, /tape-reel--right/);
  assert.match(html, /data-tape-go="back"/, 'terugspoelen');
  assert.match(html, /data-tape-go="fwd"/, 'vooruitspoelen');

  // DE KERN VAN HET IDEE: de nummers staan er als inhoud, niet als knoppen.
  // Zodra een track een speel-url draagt kun je erop prikken, en dan is het
  // geen bandje meer maar een lijst met een cassetteplaatje erboven.
  const lijst = html.slice(html.indexOf('<ol class="tape-tracks"'));
  assert.doesNotMatch(lijst, /data-pcms-track-url/, 'een aanklikbaar nummer hoort hier niet');
  assert.doesNotMatch(lijst, /<button/, 'en een knop ook niet');

  // De afspeelknop leunt wel op de bestaande speler, anders bouwen we een
  // tweede speler naast de site-speler.
  assert.match(html, /data-pcms-album-id="album-tape"/);
  assert.match(html, /data-pcms-track-url="\/a\.mp3"/);

  // En geen albumopmaak: dat was de hele reden voor een eigen vorm.
  assert.doesNotMatch(html, /class="post-album"/);
});
