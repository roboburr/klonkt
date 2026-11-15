// De open deuren in je lucht (shaer-3dwr). Met één instelling volgt Klonkt de
// deur van iedereen in de lucht van de eigenaar, en de Updates van hun Klonkts
// houden de stand in het geheugen vers. Playtime leest het in
// <actor>/openDoors, met since en wait zoals de inbox.
//
// In-memory SQLite. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
const BASE = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const W = (await import('../src/services/door-watch.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');
const IK = `${BASE}/ap/users/ik`;

const tokens = {};
for (const [naam, scope] of [['playtime', 'read write:door'], ['lees', 'read'], ['deur', 'write:door']]) {
  tokens[naam] = `test-token-${naam}-` + 'f'.repeat(24);
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(tokens[naam]).digest('base64url'), 'playtime', 'u1', 'ik', scope);
}

// De lucht: een volger met een deur, iemand die ik volg met een deur, iemand
// die ik volg zonder deur, en een vreemde met een deur die er niet in hoort.
const host = (n) => `https://203.0.113.${n}`;
const ANNA = `${host(60)}/users/anna`;   // volgt mij, heeft een deur
const BEN = `${host(61)}/users/ben`;     // ik volg hem, heeft een deur
const CAS = `${host(62)}/users/cas`;     // ik volg hem, geen deur
const VREEMD = `${host(63)}/users/vreemd`;
const deurVan = (a) => `${a}/door`;
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)').run('ik', ANNA, `${ANNA}/inbox`);
for (const a of [BEN, CAS]) {
  db.prepare("INSERT INTO ap_following (slug, actor_uri, inbox, follow_id, status) VALUES (?,?,?,?, 'accepted')").run('ik', a, `${a}/inbox`, `${IK}#follow-${a}`);
}
// Een volgverzoek dat nog wacht hoort niet bij de lucht.
db.prepare("INSERT INTO ap_following (slug, actor_uri, inbox, follow_id, status) VALUES (?,?,?,?, 'pending')").run('ik', VREEMD, `${VREEMD}/inbox`, `${IK}#follow-vreemd`);

const deurOpen = new Set();   // welke deuren elders open staan, voor een navraag
const bezorgd = [];
let actorGets = 0;
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const LOKAAL = `http://127.0.0.1:${server.address().port}`;
server.unref();
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(LOKAAL)) return echteFetch(url, opts);
  if (opts.method === 'POST') {
    try { bezorgd.push({ naar: u, activiteit: JSON.parse(opts.body) }); } catch { /* geen JSON */ }
    return new Response('', { status: 202 });
  }
  if (u.endsWith('/door')) {
    return deurOpen.has(u)
      ? new Response(JSON.stringify({ id: u, type: 'shaer:Door', proof: { created: '2026-11-15T09:00:00Z' } }), { status: 200, headers: { 'content-type': 'application/activity+json' } })
      : new Response('{"error":"door_closed"}', { status: 404 });
  }
  actorGets++;
  const id = u.replace(/#.*$/, '');
  const metDeur = id !== CAS;
  return new Response(JSON.stringify({
    id, type: 'Person', inbox: `${id}/inbox`,
    ...(metDeur ? { 'shaer:door': { id: deurVan(id), type: 'shaer:Door' } } : {}),
  }), { status: 200, headers: { 'content-type': 'application/activity+json' } });
};
after(() => { globalThis.fetch = echteFetch; server.close(); });

const vraag = (pad, token, { method = 'GET', body } = {}) => echteFetch(`${LOKAAL}/ap/users/ik/openDoors${pad}`, {
  method,
  headers: { Authorization: `Bearer ${tokens[token]}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const lijst = async (token = 'playtime') => (await vraag('', token)).json();
const even = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const inbox = (act) => AP.handleInbox({ body: act, headers: {}, get: () => undefined, socket: {} }, 'ik', { id: act.actor });
const rij = (a) => db.prepare('SELECT * FROM ap_door_follows WHERE slug = ? AND friend_uri = ?').get('ik', a);
const update = (wie, isOpen, deur = deurVan(wie)) => inbox({
  '@context': 'https://www.w3.org/ns/activitystreams', id: `${wie}#u-${Math.random()}`, type: 'Update', actor: wie,
  object: { id: deur, type: 'shaer:Door', attributedTo: wie, 'shaer:open': isOpen },
});

test('de actor zegt waar de lijst staat', () => {
  const site = db.prepare("SELECT * FROM sites WHERE slug = 'ik'").get();
  assert.equal(AP.buildActor(BASE, site)['shaer:openDoors'], `${IK}/openDoors`);
});

test('uit staat de lijst leeg, en volgen gebeurt niet', async () => {
  const l = await lijst();
  assert.equal(l.type, 'OrderedCollection');
  assert.equal(l['shaer:followDoors'], false);
  assert.equal(l.totalItems, 0);
  assert.ok(l['shaer:cursor']);
});

test('lezen vraagt read, de schakelaar write:door', async () => {
  assert.equal((await vraag('', 'lees')).status, 200);
  assert.equal((await vraag('', 'deur')).status, 403, 'write:door leest niet');
  assert.equal((await vraag('', 'lees', { method: 'PUT', body: { 'shaer:followDoors': true } })).status, 403);
  assert.equal((await vraag('', 'playtime', { method: 'PUT', body: { 'shaer:followDoors': 'ja' } })).status, 400);
});

test('aanzetten volgt de deur van wie in de lucht staat, en verder niemand', async () => {
  bezorgd.length = 0;
  const r = await vraag('', 'playtime', { method: 'PUT', body: { 'shaer:followDoors': true } });
  assert.equal(r.status, 200);
  assert.equal((await r.json())['shaer:followDoors'], true);
  await even(150);
  const follows = bezorgd.filter((b) => b.activiteit.type === 'Follow');
  assert.deepEqual(follows.map((b) => b.activiteit.object).sort(), [deurVan(ANNA), deurVan(BEN)].sort());
  for (const f of follows) assert.equal(f.activiteit.actor, IK);
  assert.equal(rij(ANNA).status, 'pending');
  assert.equal(rij(CAS).status, 'none', 'geen deur, onthouden');
  assert.equal(rij(VREEMD), undefined, 'een wachtend volgverzoek is geen lucht');
});

test('een tweede ronde haalt niemand opnieuw op', async () => {
  const voor = actorGets;
  bezorgd.length = 0;
  await W.reconcile(BASE, 'ik');
  assert.equal(actorGets, voor);
  assert.equal(bezorgd.length, 0);
});

test('Accept zet het abonnement op accepted, en vraagt de deur meteen na', async () => {
  deurOpen.add(deurVan(BEN));
  for (const a of [ANNA, BEN]) {
    const r = rij(a);
    await inbox({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${a}#acc`, type: 'Accept', actor: a,
      object: { id: r.follow_id, type: 'Follow', actor: IK, object: r.door_id } });
    assert.equal(rij(a).status, 'accepted');
  }
  await even();
  const l = await lijst();
  assert.deepEqual(l.orderedItems.map((d) => d.attributedTo), [BEN], 'Ben stond al open, Anna niet');
  assert.equal(l.orderedItems[0]['shaer:openSince'], '2026-11-15T09:00:00.000Z', 'sinds de handtekening');
});

test('een Accept van een deurabonnement zet geen wachtende gewone Follow open', () => {
  assert.equal(db.prepare('SELECT status FROM ap_following WHERE actor_uri = ?').get(VREEMD).status, 'pending');
});

test('online komen staat er meteen; wie wacht, hoort het binnen het wachten', async () => {
  const c = (await lijst())['shaer:cursor'];
  const t0 = Date.now();
  const wachten = vraag(`?since=${encodeURIComponent(c)}&wait=10`, 'playtime');
  await even(50);
  await update(ANNA, true);
  const r = await wachten;
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 3000, 'niet de hele tien seconden');
  const l = await r.json();
  assert.deepEqual(l.orderedItems.map((d) => d.attributedTo).sort(), [ANNA, BEN].sort());
  assert.notEqual(l['shaer:cursor'], c);
});

test('niets veranderd is 304', async () => {
  const c = (await lijst())['shaer:cursor'];
  const r = await vraag(`?since=${encodeURIComponent(c)}&wait=1`, 'playtime');
  assert.equal(r.status, 304);
});

test('dicht gaat er meteen af', async () => {
  await update(BEN, false);
  assert.deepEqual((await lijst()).orderedItems.map((d) => d.attributedTo), [ANNA]);
});

test('een Update over andermans deur, of van wie we niet volgen, telt niet', async () => {
  await inbox({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${VREEMD}#nep`, type: 'Update', actor: VREEMD,
    object: { id: deurVan(BEN), type: 'shaer:Door', attributedTo: BEN, 'shaer:open': true } });
  await update(VREEMD, true);
  await update(ANNA, true, deurVan(BEN));
  assert.deepEqual((await lijst()).orderedItems.map((d) => d.attributedTo), [ANNA]);
});

test('een herstart vergeet de stand; de navraag haalt hem terug', async () => {
  W._forgetAll();
  assert.equal((await lijst()).totalItems, 0);
  deurOpen.add(deurVan(ANNA));
  deurOpen.delete(deurVan(BEN));
  await W.refresh(BASE, 'ik', { pauseMs: 0 });
  assert.deepEqual((await lijst()).orderedItems.map((d) => d.attributedTo), [ANNA]);
});

test('een Reject van een deurabonnement ontvolgt de actor niet', async () => {
  const r = rij(BEN);
  await inbox({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${BEN}#rej`, type: 'Reject', actor: BEN,
    object: { id: r.follow_id, type: 'Follow', actor: IK, object: r.door_id } });
  assert.equal(rij(BEN).status, 'rejected');
  assert.equal(db.prepare('SELECT status FROM ap_following WHERE actor_uri = ?').get(BEN).status, 'accepted', 'ik volg Ben nog');
});

test('wie uit de lucht verdwijnt, wordt opgezegd en gaat van de lijst', async () => {
  bezorgd.length = 0;
  db.prepare('DELETE FROM ap_followers WHERE actor_uri = ?').run(ANNA);
  await W.reconcile(BASE, 'ik');
  await even();
  const undo = bezorgd.find((b) => b.activiteit.type === 'Undo');
  assert.equal(undo.naar, `${ANNA}/inbox`);
  assert.equal(undo.activiteit.object.object, deurVan(ANNA));
  assert.equal(rij(ANNA), undefined);
  assert.equal((await lijst()).totalItems, 0);
});

test('uitzetten zegt alles op en maakt de lijst leeg', async () => {
  db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)').run('ik', ANNA, `${ANNA}/inbox`);
  await W.reconcile(BASE, 'ik');
  const r = rij(ANNA);
  await inbox({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${ANNA}#acc2`, type: 'Accept', actor: ANNA,
    object: { id: r.follow_id, type: 'Follow', actor: IK, object: r.door_id } });
  await even();
  bezorgd.length = 0;
  const uit = await vraag('', 'playtime', { method: 'PUT', body: { 'shaer:followDoors': false } });
  assert.equal(uit.status, 200);
  await even();
  assert.deepEqual(bezorgd.filter((b) => b.activiteit.type === 'Undo').map((b) => b.naar), [`${ANNA}/inbox`], 'alleen wat liep; Ben weigerde al, Cas had geen deur');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ap_door_follows WHERE slug = 'ik'").get().n, 0);
  const l = await lijst();
  assert.equal(l['shaer:followDoors'], false);
  assert.equal(l.totalItems, 0);
});

test('alleen een deur als object op dezelfde host telt', () => {
  assert.equal(W.doorOf({ 'shaer:door': { id: `${ANNA}/door` } }, ANNA), `${ANNA}/door`);
  assert.equal(W.doorOf({ 'shaer:door': `${ANNA}/door` }, ANNA), null, 'nooit een kale IRI');
  assert.equal(W.doorOf({ 'shaer:door': { id: 'https://elders.example/door' } }, ANNA), null, 'niet andermans host');
  assert.equal(W.doorOf({}, ANNA), null);
});
