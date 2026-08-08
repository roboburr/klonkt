// Zwaaien ter plekke: de route moet twee soorten bezoekers bedienen.
//
// Met X-Requested-With: fetch antwoordt hij JSON en blijft de pagina staan;
// zonder dat blijft het een gewoon formulier dat post en omleidt. Dat tweede
// pad is geen restant maar de no-JS-weg, en het moet werken blijven.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();

// De aflevering onderscheppen: deze test gaat over het HTTP-gedrag van de
// route, niet over federatie. Wat er de deur uit gaat leggen we wel vast.
const APmod = await import('../src/services/ActivityPubService.js');
const AP = APmod.default;
let bezorgd = [];
let bezorgingLukt = true;
AP.deliverDirectNote = async (site, opts) => { bezorgd.push(opts); return bezorgingLukt; };

const express = (await import('express')).default;
const session = (await import('express-session')).default;
const routes = (await import('../src/routes/posts.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

const app = express();
app.use(session({ secret: 't', resave: false, saveUninitialized: false }));
app.use((req, res, next) => {
  req.session.userId = 'u1';
  req.session.user = { id: 'u1', username: 'u1', role: 'god' };
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  res.locals.user = req.session.user;
  next();
});
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const zwaai = (velden, headers = {}) => fetch(base + '/messages/quick-reply', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(velden),
});

test('met de fetch-header: JSON terug, geen omleiding', async () => {
  bezorgd = []; bezorgingLukt = true;
  const r = await zwaai({ to: 'https://elders.example/users/kim', text: '👋' }, { 'X-Requested-With': 'fetch' });
  assert.equal(r.status, 200);
  assert.equal((r.headers.get('content-type') || '').split(';')[0], 'application/json');
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(bezorgd.length, 1);
  assert.equal(bezorgd[0].text, '👋');
  assert.equal(bezorgd[0].wave, true, 'het blijft een zwaai, geen gewoon bericht');
});

test('zonder die header blijft het de oude weg: omleiden met wave_sent', async () => {
  bezorgd = []; bezorgingLukt = true;
  const r = await zwaai({ to: 'https://elders.example/users/kim', text: 'Wat leuk!' });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /\/messages\?success=wave_sent$/);
  assert.equal(bezorgd[0].text, 'Wat leuk!', 'de gekozen tekst, niet een vaste');
});

test('een zwaai zonder tekst wordt geweigerd -- de val bij meerdere verzendknoppen', async () => {
  // FormData neemt de aangeklikte knop niet mee; vergeet de module de submitter,
  // dan komt het verzoek hier ZONDER text aan. Dan hoort het te falen, niet een
  // leeg bericht te versturen.
  bezorgd = [];
  const r = await zwaai({ to: 'https://elders.example/users/kim' }, { 'X-Requested-With': 'fetch' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
  assert.equal(bezorgd.length, 0, 'er mag niets vertrokken zijn');
});

test('een onbruikbare ontvanger geeft 400 in JSON, en 302 zonder de header', async () => {
  bezorgd = [];
  const a = await zwaai({ to: 'geen-uri', text: '👋' }, { 'X-Requested-With': 'fetch' });
  assert.equal(a.status, 400);
  const b = await zwaai({ to: 'geen-uri', text: '👋' });
  assert.equal(b.status, 302);
  assert.match(b.headers.get('location'), /error=quickreply/);
  assert.equal(bezorgd.length, 0);
});

test('mislukte aflevering: geen valse bevestiging', async () => {
  bezorgd = []; bezorgingLukt = false;
  const r = await zwaai({ to: 'https://elders.example/users/kim', text: '👋' }, { 'X-Requested-With': 'fetch' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).ok, false);
});

test.after(() => server.close());
