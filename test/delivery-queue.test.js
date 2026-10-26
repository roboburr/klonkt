// De bezorgwachtrij voor een Klonkt die niet altijd aan staat (shaer-xzab).
//
// Wat hier bewaakt wordt, elk met zijn eigen toets:
//   .1 een bezorging verloopt op LEEFTIJD (5 dagen), niet na zes pogingen, en
//      de treden lopen door tot een dag;
//   .2 offline zijn kost geen pogingen: een beurt die naar meer dan één server
//      op netwerkniveau faalt, schuift op zonder te tellen en laat niets
//      verlopen -- maar een SSRF-weigering of één dode server telt gewoon;
//   .3 één mislukking naar een server schuift al zijn rijen op, en per inbox
//      gaat de oudste eerst, ook bij het directe versturen.
//
// Tegen echte HTTP-servers op 127.0.0.1, toegelaten via AP_ALLOW_HOSTS, en twee
// poorten waar niets luistert als "dode server".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

// Twee inboxen die antwoorden, en wat ze kregen.
const ontvangen = [];               // { host, type, id }
const status = new Map();           // host -> HTTP-status (standaard 202)
function inbox() {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const host = req.headers.host;
      try { const a = JSON.parse(body); ontvangen.push({ host, type: a.type, id: a.id }); } catch { /* geen json */ }
      res.statusCode = status.get(host) || 202; res.end();
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
async function dichtePoort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const A = await inbox();
const B = await inbox();
const hostA = `127.0.0.1:${A.address().port}`;
const hostB = `127.0.0.1:${B.address().port}`;
const dood1 = `127.0.0.1:${await dichtePoort()}`;
const dood2 = `127.0.0.1:${await dichtePoort()}`;
process.env.AP_ALLOW_HOSTS = [hostA, hostB, dood1, dood2].join(',');
test.after(() => { A.close(); B.close(); });

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const T = await import('../src/services/ap-transport.js');
const stilWarn = (f) => async () => { const w = console.warn; console.warn = () => {}; try { await f(); } finally { console.warn = w; } };

const url = (host, pad = '/inbox') => `http://${host}${pad}`;
const leeg = () => { db.prepare('DELETE FROM ap_delivery').run(); ontvangen.length = 0; status.clear(); };
const rij = (id) => db.prepare('SELECT * FROM ap_delivery WHERE id = ?').get(id);
const alle = () => db.prepare('SELECT * FROM ap_delivery ORDER BY id').all();
function zet(inboxUrl, activity, { dagenOud = 0, attempts = 0, over = 0 } = {}) {
  T.enqueueDelivery('kind', inboxUrl, activity);
  const id = db.prepare('SELECT max(id) id FROM ap_delivery').get().id;
  db.prepare(`UPDATE ap_delivery SET attempts = ?,
      created_at = datetime('now', ?), next_at = datetime('now', ?) WHERE id = ?`)
    .run(attempts, `-${dagenOud * 24 * 60} minutes`, `${over >= 0 ? '+' : ''}${over} minutes`, id);
  return id;
}
const minutenTot = (iso) => (Date.parse(String(iso).replace(' ', 'T') + (/Z$/.test(iso) ? '' : 'Z')) - Date.now()) / 60000;

// ── .1 Verlopen op leeftijd ──────────────────────────────────────

test('de treden lopen door tot een dag, en de laatste herhaalt', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 30].map(T.deliveryBackoffMinutes), [1, 5, 15, 60, 180, 360, 720, 1440, 1440]);
});

test('zes pogingen is geen reden meer om op te geven; vijf dagen wel', stilWarn(async () => {
  leeg();
  status.set(hostA, 500);
  const jong = zet(url(hostA, '/jong'), { type: 'Create', id: 'n1' }, { dagenOud: 4, attempts: 6 });
  await T.processDeliveryQueue();
  assert.ok(rij(jong), 'vier dagen oud met zes pogingen: blijft staan');
  assert.equal(rij(jong).attempts, 7);
  assert.ok(Math.abs(minutenTot(rij(jong).next_at) - 720) < 2, 'en de trede van twaalf uur wordt gebruikt');

  leeg();
  status.set(hostA, 500);
  const oud = zet(url(hostA, '/oud'), { type: 'Create', id: 'n2' }, { dagenOud: 6, attempts: 2 });
  await T.processDeliveryQueue();
  assert.equal(rij(oud), undefined, 'zes dagen oud: opgegeven');
}));

test('de leeftijd leest SQLite-UTC zoals hij is', () => {
  const nu = Date.parse('2026-10-26T12:00:00Z');
  assert.equal(T.deliveryExpired('2026-10-21 12:00:01', nu), false);
  assert.equal(T.deliveryExpired('2026-10-21 12:00:00', nu), true);
});

// ── .2 Offline kost niets ────────────────────────────────────────

test('geen netwerk naar twee servers: opschuiven, niet tellen, niet verlopen', stilWarn(async () => {
  leeg();
  const een = zet(url(dood1), { type: 'Create', id: 'n3' }, { attempts: 3, dagenOud: 6 });
  const twee = zet(url(dood2), { type: 'Create', id: 'n4' }, { attempts: 1 });
  await T.processDeliveryQueue();
  assert.ok(rij(een) && rij(twee), 'niets opgegeven, ook niet wat oud was');
  assert.equal(rij(een).attempts, 3);
  assert.equal(rij(twee).attempts, 1);
  assert.ok(Math.abs(minutenTot(rij(een).next_at) - 2) < 1, 'een paar minuten opgeschoven');
}));

test('één dode server is gewoon een dode server, en telt', stilWarn(async () => {
  leeg();
  const id = zet(url(dood1), { type: 'Create', id: 'n5' }, { attempts: 2 });
  await T.processDeliveryQueue();
  assert.equal(rij(id).attempts, 3);
}));

test('een SSRF-weigering is een besluit, geen offline', stilWarn(async () => {
  leeg();
  const een = zet('http://127.0.0.2:9/inbox', { type: 'Create', id: 'n6' });
  const twee = zet('http://127.0.0.3:9/inbox', { type: 'Create', id: 'n7' });
  await T.processDeliveryQueue();
  assert.equal(rij(een).attempts, 1, 'geteld, ook al antwoordde niemand');
  assert.equal(rij(twee).attempts, 1);
}));

// ── .3 Per server en per inbox ───────────────────────────────────

test('één mislukking naar een server schuift al zijn rijen op', stilWarn(async () => {
  leeg();
  status.set(hostA, 503);
  const ids = ['/x', '/y', '/z'].map((p, i) => zet(url(hostA, p), { type: 'Create', id: `h${i}` }));
  const elders = zet(url(hostB), { type: 'Create', id: 'b1' });
  await T.processDeliveryQueue();
  assert.equal(ontvangen.filter((o) => o.host === hostA).length, 1, 'één verzoek naar de dode server, niet drie');
  const eerste = rij(ids[0]);
  for (const id of ids) assert.ok(minutenTot(rij(id).next_at) >= minutenTot(eerste.next_at) - 0.1, 'allemaal niet eerder dan de mislukte');
  assert.deepEqual(ids.slice(1).map((id) => rij(id).attempts), [0, 0], 'wat niet geprobeerd is, telt niet');
  assert.equal(rij(elders), undefined, 'een andere server gaat gewoon door');
}));

test('per inbox de oudste eerst: geen Delete voor de Create die nog wacht', async () => {
  leeg();
  const create = zet(url(hostA), { type: 'Create', id: 'p1' }, { over: 30 });   // wacht nog
  zet(url(hostA), { type: 'Delete', id: 'p1-del' });                              // al aan de beurt
  await T.processDeliveryQueue();
  assert.deepEqual(ontvangen, [], 'de Delete wacht op de Create');
  db.prepare("UPDATE ap_delivery SET next_at = datetime('now', '-1 minutes') WHERE id = ?").run(create);
  await T.processDeliveryQueue();
  await T.processDeliveryQueue();
  assert.deepEqual(ontvangen.map((o) => o.type), ['Create', 'Delete']);
  assert.deepEqual(alle(), []);
});

test('direct versturen gaat niet voorbij wat er voor die inbox wacht', async () => {
  leeg();
  const { private_pem } = T.getOrCreateKeys('kind');
  // De Create is AL aan de beurt, alleen nog niet opgepakt: de server zit dus
  // niet in een backoff, en alleen de volgorde per inbox houdt de Delete tegen.
  zet(url(hostA), { type: 'Create', id: 'q1' }, { over: -1 });
  await T.deliverWithRetry('kind', url(hostA), { type: 'Delete', id: 'q1-del' }, 'https://test.example/ap/users/kind#main-key', private_pem);
  assert.deepEqual(ontvangen, [], 'niet verstuurd');
  assert.deepEqual(alle().map((r) => JSON.parse(r.body).type), ['Create', 'Delete'], 'maar achteraan in de rij');
});

test('en niet naar een server die in zijn backoff zit', async () => {
  leeg();
  const { private_pem } = T.getOrCreateKeys('kind');
  zet(url(hostA, '/ander'), { type: 'Create', id: 'r1' }, { over: 30 });
  await T.deliverWithRetry('kind', url(hostA, '/nog-een'), { type: 'Create', id: 'r2' }, 'https://test.example/ap/users/kind#main-key', private_pem);
  assert.deepEqual(ontvangen, [], 'geen acht seconden time-out om hetzelfde te horen');
  assert.equal(alle().length, 2);
});

test('zonder wachtrij gaat direct versturen gewoon direct', async () => {
  leeg();
  const { private_pem } = T.getOrCreateKeys('kind');
  await T.deliverWithRetry('kind', url(hostB), { type: 'Create', id: 's1' }, 'https://test.example/ap/users/kind#main-key', private_pem);
  assert.deepEqual(ontvangen.map((o) => o.id), ['s1']);
  assert.deepEqual(alle(), []);
});

test('rijen van voor de host-kolom krijgen hun host bij het opstarten', () => {
  leeg();
  db.prepare("INSERT INTO ap_delivery (slug, inbox, body) VALUES ('kind', ?, '{}')").run(url(hostB, '/oud'));
  db.prepare('UPDATE ap_delivery SET host = NULL').run();
  { const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
  assert.equal(alle()[0].host, hostB);
});
