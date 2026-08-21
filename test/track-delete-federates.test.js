// Een track verwijderen hoort de fediverse te bereiken.
//
// Tot 21-8 gebeurde dat niet. Een post kondigde zijn verwijdering aan
// (posts.js roept deliverDelete), maar een track niet: de rij ging weg, het
// Audio-object gaf 404, en elke server die hem had geindexeerd bleef ernaar
// wijzen. Op de hub kwam dat boven als "ongbakbeat (1)", een kaartje met een
// dode link, en het viel alleen op omdat robo het zag staan.
//
// De test gaat door de ECHTE route en kijkt in de bezorgwachtrij, want een
// eigen testhaak op deliver() bestaat hier niet. De volger krijgt een inbox op
// een dichte poort: de directe poging faalt meteen, en dan hoort de activiteit
// in ap_delivery te belanden. Dat is precies het bewijs dat we zoeken, want die
// tabel was in het echte geval leeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'baas', 'b@t.nl', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run('s1', 'robo', 'Soundfabrics', 'u1');
// Een dichte poort: faalt onmiddellijk, geen DNS, geen wachttijd.
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)')
  .run('robo', 'https://elders.test/ap/users/x', 'http://127.0.0.1:1/inbox');

const TRACK = 'trk-481fef66';
db.prepare('INSERT INTO audio_tracks (id, site_id, title) VALUES (?,?,?)')
  .run(TRACK, 's1', 'ongbakbeat (1)');

const express = (await import('express')).default;
const router = (await import('../src/routes/admin-audio.js')).default;
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  req.session = { user: { id: 'u1', role: 'god' } };
  res.locals.site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('robo');
  res.locals.siteUrlBase = '';
  next();
});
app.use('/admin/audio', router);

const server = app.listen(0);
server.unref();
const poort = server.address().port;

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

test('een verwijderde track kondigt zichzelf af bij de volgers', async () => {
  const r = await fetch(`http://127.0.0.1:${poort}/admin/audio/${TRACK}/delete`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
  }).catch((e) => assert.fail(`de route antwoordde niet (${e.name})`));
  assert.ok(r.status === 302 || r.status === 200, 'verwijderen mag niet stranden, kreeg ' + r.status);

  assert.equal(
    db.prepare('SELECT count(*) c FROM audio_tracks WHERE id = ?').get(TRACK).c, 0,
    'de rij hoort weg te zijn',
  );

  // De bezorging is best-effort en async: even de mislukte poging laten landen.
  for (let i = 0; i < 20 && !db.prepare('SELECT count(*) c FROM ap_delivery').get().c; i++) await wacht(100);

  const rij = db.prepare('SELECT * FROM ap_delivery').get();
  assert.ok(rij, 'er hoort een bezorging in de wachtrij te staan; leeg betekent dat er niets is verstuurd');

  const act = JSON.parse(rij.body);
  assert.equal(act.type, 'Delete');
  assert.equal(act.object.type, 'Tombstone');
  // De identiteit moet dezelfde zijn als die het Audio-object droeg, anders
  // ruimt de ontvanger niets op: hij kent dat id niet.
  assert.equal(act.object.id, `https://test.example/ap/users/robo/tracks/${TRACK}`);
  assert.equal(act.actor, 'https://test.example/ap/users/robo');
});

test('het id in de Delete is exact het id waaronder de track de deur uit ging', async () => {
  // De echte valkuil bij dit soort fixes: een tweede plek die het id opnieuw
  // samenstelt en er net naast zit. Daarom bouwt trackUri() hem nu op een plek,
  // en vergelijken we hier met wat de bouwkant zelf produceert.
  const muziek = await import('../src/services/music/index.js');
  const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('robo');
  const audio = muziek.buildTrackAudio('https://test.example', site, { id: 'abc-123', title: 'x' });
  assert.equal(audio.id, muziek.trackUri('https://test.example', site, 'abc-123'));
});
