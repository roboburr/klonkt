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
  // Het teken zat eerst in de tekst; nu staat er een echte cassette getekend en
  // is het woord genoeg. De eis blijft dezelfde: hij noemt zichzelf goed.
  assert.match(html, /class="tape-kind">Mixtape</, 'een mixtape hoort zichzelf zo te noemen');
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

test('de cassetteknop staat in de selectorlijst van de speler', () => {
  // DIT IS DE TEST DIE ONTBRAK. De markup-tests hierboven waren groen terwijl
  // op de knop drukken niets deed: audio-player.js kiest zijn knoppen met een
  // lijst met KLASSENAMEN, niet met een regel over data-attributen. Alle juiste
  // data-pcms-* dragen helpt dan niets.
  const speler = fs.readFileSync('src/assets/js/audio-player.js', 'utf8');
  const m = speler.match(/const PLAY_SELECTOR =\s*\n?\s*'([^']+)'/);
  assert.ok(m, 'PLAY_SELECTOR moet te vinden zijn -- is hij hernoemd, dan dekt deze test niets meer');
  assert.match(m[1], /\.tape-btn--play/,
    'zonder deze klasse doet de afspeelknop van het bandje niets');
});

test('een bandje gaat als EEN object de speler in', () => {
  const speler = fs.readFileSync('src/assets/js/audio-player.js', 'utf8');
  // De stand moet vanaf het blok worden doorgegeven; zonder dit is een mixtape
  // in de speler gewoon weer een rij nummers.
  assert.match(speler, /asTape: album\.dataset\.pcmsAlbumKind === 'mixtape'/);
  // En hij moet een paginawissel overleven, anders valt de speler halverwege
  // terug op de nummertitel.
  assert.match(speler, /queue, currentIndex, albumName, tapeMode,/, 'in de sessie opslaan');
  assert.match(speler, /tapeMode = !!s\.tapeMode;/, 'en terugzetten');
  // De opgeslagen tijd is de positie BINNEN het nummer, ook in bandmodus: bij
  // herstellen begint de keten opnieuw. Slaat hij de bandteller op, dan springt
  // een hersteld bandje naar een plek die in dat nummer niet bestaat.
  assert.match(speler, /time: trackTijd\(\)\.cur \|\| 0,/);
});

test('spoelen gaat in seconden, niet per nummer', () => {
  const mod = fs.readFileSync('src/assets/js/mod/tape.js', 'utf8');
  assert.match(mod, /seekBy\(/, 'spoelen hoort over de tijdlijn te gaan');
  // next()/prev() mag hier niet meer voorkomen als spoelgebaar: dat is een
  // playlistknop en maakt van de cassette een lijst met een plaatje.
  assert.doesNotMatch(mod, /p\.next\(\); else p\.prev\(\)/, 'de oude sprong per nummer');
});

test('een bandje loopt niet rond, aan geen van beide kanten', () => {
  const speler = fs.readFileSync('src/assets/js/audio-player.js', 'utf8');

  // De keten mag na het laatste nummer niet nummer een er weer achter hangen.
  // Dat was de stilste van de drie: omdat het EEN doorlopende tijdlijn is merk
  // je die omloop niet eens als een trackwissel, de band gaat gewoon door.
  assert.match(speler, /if \(tapeMode && volgendeInRij > queue\.length - 1\) return;/,
    'de keten hoort te stoppen aan het eind van de band');

  // ended roept next() aan, dus zonder deze tak begint de band opnieuw.
  assert.match(speler, /if \(tapeMode && currentIndex >= queue\.length - 1\) \{ pause\(\); return; \}/,
    'aan het eind stoppen in plaats van omlopen');

  // En terugspoelen voorbij het begin levert de kop van de band op, niet het
  // laatste nummer.
  assert.match(speler, /if \(tapeMode && currentIndex === 0\) \{/,
    'aan het begin niet naar achteren omlopen');

  // Alle drie de modulo's zijn nog aanwezig voor de NIET-bandmodus: een gewone
  // playlist hoort wel te blijven rondlopen.
  assert.equal((speler.match(/% queue\.length/g) || []).length, 3,
    'de omloop van een gewone wachtrij mag niet gesneuveld zijn');
});

test('terugspoelen komt in het vorige nummer uit aan het EIND', () => {
  const speler = fs.readFileSync('src/assets/js/audio-player.js', 'utf8');
  // Zonder dit sprong terugspoelen naar de kop van het vorige nummer, en kwam
  // je nooit ergens in het midden uit -- dat is geen terugspoelen maar
  // terugspringen. Geldt voor de blob-motor; op MSE is de band een tijdlijn en
  // gaat het vanzelf goed.
  assert.match(speler, /pendingSeek = Number\.MAX_SAFE_INTEGER;/);
});

test('aan het eind van de band gaat de stream dicht', () => {
  const speler = fs.readFileSync('src/assets/js/audio-player.js', 'utf8');
  // ZONDER DIT HANGT DE BAND. Bij een MediaSource vuurt `ended` pas als de
  // stream gesloten is. Sinds een bandje niet meer rondloopt haakt de keten na
  // het laatste nummer niets meer aan, en dan bleef hij op de laatste seconde
  // staan: teller stil, isPlaying() waar, spoelen draaiend. Gemeten op dev
  // (22-8): 125,6 van 125,7 en daar bleef hij staan.
  assert.match(speler, /const laatsteVanDeBand = tapeMode && qIndex >= queue\.length - 1;/);
  assert.match(speler, /if \(\(queue\.length === 1 \|\| laatsteVanDeBand\) && ms && ms\.readyState === 'open'\)/);
});
