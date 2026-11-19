// Gezichten verversen op verzoek van de app, en overal waar een kopie staat
// (shaer-9r7f, vervolg op shaer-xc4g).
//
//   1. Een ververst profiel ververst ook de kopieën: de schrijver van een
//      bericht in de tijdlijn, van een antwoord, van een bericht aan ons.
//   2. De app vraagt Klonkt bepaalde mensen opnieuw op te halen (de gezichten
//      die alleen een initiaal tonen). Alleen wie we kennen, per actor hooguit
//      eens per dag, met de leesscope.
//   3. De Connect-pagina toont naam en avatar van wie alleen ons volgt.
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
process.env.AP_ALLOW_HOSTS = 'elders.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;

const SCHRIJVER = 'https://elders.example/users/schrijver';
const ONBEKEND = 'https://elders.example/users/onbekend';
const OUD = 'https://elders.example/avatars/oud.png';
const NIEUW = 'https://elders.example/avatars/nieuw.png';
const persoon = (id) => ({ id, type: 'Person', preferredUsername: id.split('/').pop(), name: 'Nieuwe naam', icon: { type: 'Image', url: NIEUW } });

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'ik', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
const tokenVoor = (scope) => {
  const t = `test-token-${scope}-` + crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(t).digest('base64url'), 'shaer', 'u1', 'ik', scope);
  return t;
};

const kopieen = () => {
  for (const t of ['ap_timeline', 'ap_interactions', 'ap_mentions']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, author_icon, content) VALUES ('t1','ik',?,'Oude naam',?,'<p>x</p>')`).run(SCHRIJVER, OUD);
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_icon, content) VALUES ('reply','p1','r1',?,'Oude naam',?,'<p>x</p>')`).run(SCHRIJVER, OUD);
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, actor_icon) VALUES ('ik','m1',?,'Oude naam',?)`).run(SCHRIJVER, OUD);
};
const iconen = () => [
  db.prepare('SELECT author_icon i, author_name n FROM ap_timeline WHERE author_uri = ?').get(SCHRIJVER),
  db.prepare('SELECT actor_icon i, actor_name n FROM ap_interactions WHERE actor_uri = ?').get(SCHRIJVER),
  db.prepare('SELECT actor_icon i, actor_name n FROM ap_mentions WHERE actor_uri = ?').get(SCHRIJVER),
];

test('een ververst profiel ververst ook elke kopie', () => {
  kopieen();
  assert.ok(AP.refreshActorDisplay(SCHRIJVER, persoon(SCHRIJVER)) >= 3, 'telt de kopieën mee');
  for (const r of iconen()) {
    assert.equal(r.i, NIEUW);
    assert.equal(r.n, 'Nieuwe naam');
  }
});

// De app-route, tegen een gestubde fetch -- per toets gezet, niet op
// moduleniveau: de testrunner begint al terwijl deze module nog op zijn
// top-level await wacht, en dan liep het ophalen tegen de echte fetch aan.
const gehaald = [];
const echt = globalThis.fetch;
const metStub = async (fn) => {
  globalThis.fetch = async (url) => {
    gehaald.push(String(url));
    return new Response(JSON.stringify(persoon(String(url))), { status: 200, headers: { 'Content-Type': 'application/activity+json' } });
  };
  try { return await fn(); } finally { globalThis.fetch = echt; }
};
const express = (await import('express')).default;
const app = express();
app.use((await import('../src/routes/activitypub.js')).default);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
server.unref();
after(() => server.close());
const vraag = (actors, token) => echt(`http://127.0.0.1:${server.address().port}/ap/users/ik/actors/refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ actors }),
});
const wacht = async (klaar) => { for (let i = 0; i < 100 && !klaar(); i++) await new Promise((r) => setTimeout(r, 20)); };

test('de app vraagt een gezicht opnieuw op, met alleen de leesscope', () => metStub(async () => {
  kopieen();
  const r = await vraag([SCHRIJVER, ONBEKEND, 'http://elders.example/users/niet-https', 42], tokenVoor('read'));
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { requested: 1, skipped: 3 }, 'onbekend, geen https en geen adres tellen als overgeslagen');
  await wacht(() => iconen()[0].i === NIEUW);
  assert.ok(iconen().every((x) => x.i === NIEUW), 'elke kopie ververst');
  assert.ok(gehaald.includes(SCHRIJVER));
  assert.ok(!gehaald.includes(ONBEKEND), 'wie we niet kennen, halen we niet op: geen ophaaldienst');
}));

test('per actor hooguit eens per dag', () => metStub(async () => {
  const voor = gehaald.length;
  const r = await vraag([SCHRIJVER], tokenVoor('read'));
  assert.deepEqual(await r.json(), { requested: 0, skipped: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gehaald.length, voor);
}));

test('zonder geldig token: 401', async () => {
  assert.equal((await vraag([SCHRIJVER])).status, 401);
  assert.equal((await vraag([SCHRIJVER], 'test-token-bestaat-niet-' + 'x'.repeat(20))).status, 401);
});

test('Connect toont naam en avatar van wie alleen ons volgt', () => {
  db.prepare(`INSERT INTO ap_followers (slug, actor_uri, inbox, name, handle, icon) VALUES ('ik', ?, ?, 'Volger', '@volger@elders.example', ?)`)
    .run('https://elders.example/users/volger', 'https://elders.example/users/volger/inbox', NIEUW);
  const c = AP.listConnections('ik').find((x) => x.actor_uri === 'https://elders.example/users/volger');
  assert.equal(c.direction, 'follower');
  assert.equal(c.name, 'Volger');
  assert.equal(c.icon, NIEUW);
  assert.equal(c.handle, '@volger@elders.example');
});
