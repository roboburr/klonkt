// Ook de directe verzenders gaan langs de volgorde per inbox (shaer-xzab.3).
//
// Drie plekken verstuurden zelf met deliver() en zetten pas bij een mislukking
// in de rij: een antwoord (deliverReply), het wissen daarvan
// (deliverOutboxDelete) en een direct bericht (deliverDirectNote, ook de
// hulpvraag). Zo kon een Delete aankomen vóór de Create die nog in de rij
// wachtte -- en stond het antwoord daarna weer op die server.
//
// Tegen echte HTTP-servers op 127.0.0.1, toegelaten via AP_ALLOW_HOSTS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const ontvangen = [];      // { pad, type }
let status = 202;
const ander = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const host = `http://${req.headers.host}`;
    if (req.method === 'GET' && req.url === '/users/oma') {
      res.setHeader('Content-Type', 'application/activity+json');
      return res.end(JSON.stringify({ id: `${host}/users/oma`, type: 'Person', preferredUsername: 'oma', inbox: `${host}/users/oma/inbox` }));
    }
    try { const a = JSON.parse(body); ontvangen.push({ pad: req.url, type: a.type }); } catch { /* geen json */ }
    res.statusCode = status; res.end();
  });
});
await new Promise((r) => ander.listen(0, '127.0.0.1', r));
const host = `127.0.0.1:${ander.address().port}`;
const inbox = `http://${host}/inbox`;
process.env.AP_ALLOW_HOSTS = host;
test.after(() => ander.close());

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'robin', 'r@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('me');
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox) VALUES (?,?,?)').run('me', `http://${host}/users/volger`, inbox);
const parent = {
  id: 1, post_id: '', actor_uri: 'https://unresolvable.invalid/u/ness',
  actor_url: 'https://unresolvable.invalid/@ness', actor_handle: '@ness@unresolvable.invalid',
  object_uri: 'https://unresolvable.invalid/notes/9',
};

const rij = () => db.prepare('SELECT * FROM ap_delivery ORDER BY id').all();
const typen = () => rij().map((r) => JSON.parse(r.body).type);
const leeg = () => { db.prepare('DELETE FROM ap_delivery').run(); ontvangen.length = 0; status = 202; };
const stil = (f) => async () => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { await f(); } finally { console.log = l; console.warn = w; } };

test('een gewist antwoord komt niet aan vóór het antwoord zelf', stil(async () => {
  leeg();
  status = 503;                                            // de server van de volger hapert
  const r = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'eerst' });
  assert.equal(r.delivered, 0);
  assert.deepEqual(typen(), ['Create'], 'het antwoord wacht in de rij');

  status = 202;                                            // hij is er weer, de rij is nog niet geweest
  ontvangen.length = 0;
  await AP.deliverOutboxDelete(site, r.id);
  assert.deepEqual(ontvangen, [], 'de Delete gaat niet voor');
  assert.deepEqual(typen(), ['Create', 'Delete'], 'hij wacht achter de Create');

  await AP.processDeliveryQueue();
  await AP.processDeliveryQueue();
  assert.deepEqual(ontvangen.map((o) => o.type), ['Create', 'Delete'], 'en zo komen ze aan');
}));

test('een antwoord gaat niet voorbij wat er voor die inbox al wacht', stil(async () => {
  leeg();
  AP.enqueueDelivery('me', inbox, { type: 'Create', id: 'https://klonkt.test/eerder' });
  const r = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'later' });
  assert.equal(r.delivered, 0, 'niet als verstuurd geteld');
  assert.deepEqual(ontvangen, []);
  assert.equal(rij().length, 2);
}));

test('zonder wachtrij gaat een antwoord gewoon meteen, en telt', stil(async () => {
  leeg();
  const r = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'meteen' });
  assert.equal(r.delivered, 1);
  assert.deepEqual(ontvangen.map((o) => o.type), ['Create']);
  assert.deepEqual(rij(), []);
}));

test('een direct bericht gaat niet voorbij wat er voor die inbox al wacht', stil(async () => {
  leeg();
  const omaInbox = `http://${host}/users/oma/inbox`;
  AP.enqueueDelivery('me', omaInbox, { type: 'Create', id: 'https://klonkt.test/eerder' });
  const r = await AP.deliverDirectNote(site, { recipients: [`http://${host}/users/oma`], text: 'hoi oma' });
  assert.ok(r, 'het bericht is gemaakt');
  assert.equal(r.delivered, 0);
  assert.deepEqual(ontvangen, [], 'niets voorbij de wachtende');
  assert.deepEqual(rij().map((x) => x.inbox), [omaInbox, omaInbox]);
}));

test('zonder wachtrij gaat een direct bericht meteen, en telt', stil(async () => {
  leeg();
  const r = await AP.deliverDirectNote(site, { recipients: [`http://${host}/users/oma`], text: 'hoi oma, nu' });
  assert.equal(r.delivered, 1);
  assert.deepEqual(ontvangen.map((o) => o.type), ['Create']);
}));
