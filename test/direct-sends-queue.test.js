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

test('een gewist antwoord dat nog wachtte, komt nooit meer aan', stil(async () => {
  // Robins vraag (26-10): een Delete van een Create die nog in de rij staat,
  // hoort intern opgelost te worden. Eerst zorgde de volgorde per inbox er
  // alleen voor dat de Delete NA de Create kwam -- maar de Create kwam dan nog.
  leeg();
  status = 503;                                            // de server van de volger hapert
  const r = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'eerst' });
  assert.equal(r.delivered, 0);
  assert.deepEqual(typen(), ['Create'], 'het antwoord wacht in de rij');

  status = 202;                                            // hij is er weer, de rij is nog niet geweest
  ontvangen.length = 0;
  await AP.deliverOutboxDelete(site, r.id);
  await AP.processDeliveryQueue();
  assert.ok(!ontvangen.some((o) => o.type === 'Create'), 'het gewiste antwoord gaat niet meer de deur uit');
  // Hij is wel één keer geprobeerd (de 503), en dan KAN hij aangekomen zijn:
  // dan gaat de Delete toch, voor de zekerheid.
  assert.deepEqual(ontvangen.map((o) => o.type), ['Delete']);
  assert.deepEqual(rij(), []);
}));

test('nooit geprobeerd en gewist: er gaat helemaal niets heen', stil(async () => {
  leeg();
  // De server zit in zijn backoff, dus het antwoord gaat meteen de rij in,
  // zonder poging; daarna wordt het gewist.
  AP.enqueueDelivery('me', `http://${host}/ander-pad`, { type: 'Create', id: 'https://klonkt.test/iets' });
  db.prepare("UPDATE ap_delivery SET next_at = datetime('now', '+30 minutes')").run();
  const r = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'nooit verstuurd' });
  assert.equal(rij().filter((x) => x.inbox === inbox).length, 1, 'het antwoord wacht, ongeprobeerd');
  await AP.deliverOutboxDelete(site, r.id);
  assert.deepEqual(rij().filter((x) => x.inbox === inbox), [], 'Create weg, en geen Delete erachteraan');
  assert.deepEqual(ontvangen, []);
  assert.equal(rij().length, 1, 'wat er voor een andere inbox wachtte, blijft');
}));

test('alleen de Create en Update van DAT object, en alleen voor die inbox', () => {
  leeg();
  const obj = 'https://klonkt.test/ap/notes/x';
  AP.enqueueDelivery('me', inbox, { type: 'Create', id: `${obj}#create`, object: { id: obj } }, { tried: false });
  AP.enqueueDelivery('me', inbox, { type: 'Update', id: `${obj}#update`, object: { id: obj } }, { tried: false });
  AP.enqueueDelivery('me', inbox, { type: 'Create', id: 'y#create', object: { id: 'https://klonkt.test/ap/notes/y' } }, { tried: false });
  AP.enqueueDelivery('me', `http://${host}/elders`, { type: 'Create', id: `${obj}#create`, object: { id: obj } }, { tried: false });
  // Bewust ALLEEN wat de inhoud draagt. Een Announce of Add van een gewist
  // object is onschuldig: de ontvanger haalt het op en krijgt een 404.
  AP.enqueueDelivery('me', inbox, { type: 'Announce', id: `${obj}#boost`, object: obj }, { tried: false });
  const r = AP.cancelUndelivered(inbox, obj);
  assert.deepEqual(r, { cancelled: 2, mayHaveArrived: false });
  assert.deepEqual(rij().map((x) => [x.inbox.endsWith('/inbox') ? 'deze' : 'andere', JSON.parse(x.body).type, String(JSON.parse(x.body).object.id || JSON.parse(x.body).object).slice(-1)]),
    [['deze', 'Create', 'y'], ['andere', 'Create', 'x'], ['deze', 'Announce', 'x']]);
});

test('een bewerking gaat niet voorbij het antwoord dat nog wacht', stil(async () => {
  leeg();
  status = 503;
  const r = await AP.deliverReply(site, { postId: '', postSlug: null, parent, text: 'origineel' });
  status = 202; ontvangen.length = 0;
  await AP.deliverOutboxUpdate(site, r.id, 'bewerkt');
  assert.deepEqual(ontvangen, [], 'de Update gaat niet voor: dan negeert de ander hem, en brengt de Create daarna de oude tekst');
  assert.deepEqual(typen(), ['Create', 'Update']);
}));

test('een guardian-activiteit gaat niet voorbij wat er voor die inbox wacht', stil(async () => {
  leeg();
  const omaInbox = `http://${host}/users/oma/inbox`;
  AP.enqueueDelivery('me', omaInbox, { type: 'Create', id: 'https://klonkt.test/eerder' });
  await AP.deliverToActor(site, `http://${host}/users/oma`, { type: 'Offer', id: 'https://klonkt.test/offer/1' });
  assert.deepEqual(ontvangen, []);
  assert.equal(rij().filter((x) => x.inbox === omaInbox).length, 2);
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
