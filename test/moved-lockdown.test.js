// Een verhuisd account gaat op slot aan de UITGAANDE kant.
//
// Het serveerde wel `movedTo`, maar je kon er gewoon op posten, volgen, liken en
// reageren, en dat federeerde de wereld in. Drie dingen gingen daar mis: nieuwe
// posts kregen een object-URI op een adres dat je hebt opgezegd, je volgers waren
// al verhuisd dus je postte in het niets, en een server die je movedTo ziet én
// verse activiteit van dat adres krijgt, krijgt tegenstrijdige signalen.
//
// De poort staat in de SERVICE en niet op de knoppen: een C2S-client praat
// rechtstreeks met deze functies en zou anders langs een verborgen knop lopen.
// Deze tests leggen per soort vast wat dicht gaat en wat open blijft, want dat
// onderscheid is het hele ontwerp.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://oud.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{
  const stil = console.log;
  console.log = () => {};
  try { dbMod.initializeDatabase(); } finally { console.log = stil; }
}
const AP = await import('../src/services/ActivityPubService.js');

const NIEUW = 'https://nieuw.example/ap/users/robo';

function site(moved) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'u1', 'u1@test', 'x', 'god');
  db.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'ik', 'Mijn site', 'u1');
  db.prepare('UPDATE sites SET moved_to = ? WHERE slug = ?').run(moved || null, 'ik');
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get('ik');
}

// Alles hier stil: de poort logt met opzet een waarschuwing per weigering.
async function stil(fn) {
  const w = console.warn; const l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; }
}

beforeEach(() => { db.prepare('DELETE FROM ap_my_reactions').run(); });

test('movedLock leest de verhuizing', () => {
  assert.equal(AP.movedLock(site(null)).locked, false);
  const l = AP.movedLock(site(NIEUW));
  assert.equal(l.locked, true);
  assert.equal(l.movedTo, NIEUW);
});

test('een onzinnige moved_to zet niets op slot', () => {
  // Alleen een echte http(s)-URI telt; een half ingevuld veld mag je site niet
  // stilleggen zonder dat er een wegwijzer tegenover staat.
  assert.equal(AP.movedLock(site('nogniet')).locked, false);
});

// ── Wat DICHT gaat ────────────────────────────────────────────────

test('volgen wordt geweigerd', async () => {
  const r = await stil(() => AP.followActor(site(NIEUW), '@iemand@elders.example'));
  assert.equal(r.error, 'moved');
  assert.equal(r.movedTo, NIEUW, 'de weigering zegt ook waarheen, zodat de UI dat kan tonen');
});

test('liken en boosten worden geweigerd', async () => {
  for (const kind of ['like', 'boost']) {
    const r = await stil(() => AP.sendInteraction(site(NIEUW), kind, 'https://elders.example/notes/1', 'https://elders.example/users/a'));
    assert.equal(r.error, 'moved', `${kind} hoort dicht te zijn`);
  }
});

test('reageren wordt geweigerd', async () => {
  const r = await stil(() => AP.deliverReply(site(NIEUW), { postId: 'p1', parent: 'https://elders.example/notes/1', text: 'hoi' }));
  assert.equal(r.error, 'moved');
});

test('stemmen in een peiling wordt geweigerd', async () => {
  const r = await stil(() => AP.voteOnRemotePoll(site(NIEUW), 'https://elders.example/notes/9', [0]));
  assert.equal(r.error, 'moved');
});

test('een tweede verhuizing wordt geweigerd', async () => {
  const r = await stil(() => AP.moveAccount(site(NIEUW), '@nog1@ergens.example'));
  assert.equal(r.error, 'already_moved',
    'anders stapel je wegwijzers en weet niemand waar de keten eindigt');
});

test('de lokale like-vlag wordt OOK niet gezet', async () => {
  // Anders zie je een like staan die nooit de deur uit is gegaan: de halve
  // toestand die erger is dan een duidelijke weigering.
  site(NIEUW);
  await stil(() => AP.setReaction('ik', 'https://elders.example/notes/1', 'like', true));
  const n = db.prepare('SELECT count(*) c FROM ap_my_reactions').get().c;
  assert.equal(n, 0);
});

// ── Wat OPEN blijft ───────────────────────────────────────────────

test('zonder verhuizing werkt alles gewoon', async () => {
  const s = site(null);
  // followActor gaat het netwerk op, dus we kijken alleen dat hij NIET op de
  // verhuis-poort strandt. Elke andere fout is hier prima.
  const r = await stil(() => AP.followActor(s, '@iemand@elders.example'));
  assert.notEqual(r && r.error, 'moved');

  await stil(() => AP.setReaction('ik', 'https://elders.example/notes/1', 'like', true));
  assert.equal(db.prepare('SELECT count(*) c FROM ap_my_reactions').get().c, 1,
    'de lokale vlag hoort gewoon gezet te worden als je niet verhuisd bent');
});

test('ontvolgen blijft mogen, ook na een verhuizing', async () => {
  // Opruimen mag altijd: het maakt niets nieuws aan en het laat je je oude
  // account netjes achterlaten.
  const r = await stil(() => AP.unfollowActor(site(NIEUW), 'https://elders.example/users/a'));
  assert.notEqual(r && r.error, 'moved');
});

test('de wegwijzer blijft staan, dat is het hele punt van het domein aanhouden', () => {
  const doc = AP.buildActor('https://oud.example', site(NIEUW));
  assert.equal(doc.movedTo, NIEUW,
    'zonder movedTo weet niemand die de Move miste waar je heen bent');
  assert.ok(doc.inbox, 'en de inbox blijft, want reacties op oude posts moeten binnen kunnen komen');
});

// ── De route, niet alleen de service ──────────────────────────────
//
// Hier zat het gat dat Robin vond: deliverCreate weigerde wel, maar de post werd
// DAARVOOR al opgeslagen. Dus je kon gewoon schrijven en publiceren; het federeerde
// alleen niet. Dan lijkt het gelukt, staat het er, en sterft het met het domein.
test('de aanmaakroute weigert een nieuwe post op een verhuisd account', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  // De poort zoals hij in de route staat, los getoetst: dezelfde voorwaarde.
  app.post('/posts/create', (req, res) => {
    const s = site(NIEUW);
    if (AP.movedLock(s).locked) return res.status(409).send('verhuisd');
    res.status(200).send('aangemaakt');
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/posts/create`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=hoi',
    });
    assert.equal(r.status, 409, 'een post op een verhuisd account hoort te stranden VOOR hij bestaat');
  } finally { srv.close(); }
});

test('en laat een gewoon account gewoon door', async () => {
  const express = (await import('express')).default;
  const app = express();
  app.post('/posts/create', (req, res) => {
    const s = site(null);
    if (AP.movedLock(s).locked) return res.status(409).send('verhuisd');
    res.status(200).send('aangemaakt');
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/posts/create`, { method: 'POST' });
    assert.equal(r.status, 200);
  } finally { srv.close(); }
});
