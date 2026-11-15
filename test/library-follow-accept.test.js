// Wie de BIBLIOTHEEK volgt, krijgt ook echt een Accept terug (shaer-0nh).
//
// Aanleiding, twee fouten achter elkaar sinds ap-inbox.js uit de dienst werd
// gehaald. Eerst: `luisteraars` was daar nooit geïmporteerd, dus een Follow op
// /library (en de Undo ervan) liep op een ReferenceError en werd een 500.
// Daarachter: de Accept werd ondertekend met `keys.privatePem`, maar
// getOrCreateKeys geeft de databaserij terug, met `private_pem`. De sleutel was
// dus undefined, crypto.sign gooide, en de `.catch(() => {})` slikte het in.
// Een server die onze bibliotheek volgde (Funkwhale) hoorde zo nooit ja.
//
// De fetch is gestubd: het gaat om WAT er de deur uit gaat, niet om echte HTTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const { getOrCreateKeys } = await import('../src/services/ap-transport.js');
const { luisteraars } = await import('../src/services/music/index.js');

db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES ('u1','u1','u1@t','x','god')").run();
db.prepare("INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES ('s1','band','De Band','u1',1)").run();

// IP-literal: safeFetch slaat de DNS-lookup over en de stub vangt de rest.
const VOLGER = 'https://203.0.113.82/federation/actors/iemand';
const bezorgd = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'POST') {
    try {
      bezorgd.push({ naar: u, headers: new Headers(opts.headers), body: opts.body, activiteit: JSON.parse(opts.body) });
    } catch { /* niet-JSON telt niet mee */ }
    return new Response('', { status: 202 });
  }
  return new Response(JSON.stringify({
    id: VOLGER, type: 'Person', preferredUsername: 'iemand', inbox: `${VOLGER}/inbox`,
  }), { status: 200, headers: { 'content-type': 'application/activity+json' } });
};
after(() => { globalThis.fetch = echteFetch; });

// De bezorging is fire-and-forget: wacht tot hij er is, of geef het op.
async function wachtOp(pred, ms = 2000) {
  const tot = Date.now() + ms;
  while (Date.now() < tot) {
    const hit = bezorgd.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test('een Follow op /library levert een ondertekende Accept bij de volger', async () => {
  bezorgd.length = 0;
  const follow = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${VOLGER}#follow-library`, type: 'Follow', actor: VOLGER,
    object: 'https://klonkt.test/ap/users/band/library',
  };
  const st = await AP.handleInbox({
    body: follow, headers: {}, get: () => undefined, socket: {},
  }, 'band', { id: VOLGER });
  assert.equal(st, 202);
  assert.equal(luisteraars.isLuisteraar('band', VOLGER), true, 'de luisteraar staat erbij');

  const acc = await wachtOp((b) => b.activiteit.type === 'Accept');
  assert.ok(acc, 'er is een Accept bezorgd');
  assert.equal(acc.naar, `${VOLGER}/inbox`);
  assert.equal(acc.activiteit.actor, 'https://klonkt.test/ap/users/band');
  assert.equal(acc.activiteit.object.id, follow.id, 'het antwoord gaat over ZIJN Follow');

  // En de handtekening klopt met de sleutel die ons actor-document publiceert.
  const sig = acc.headers.get('signature');
  assert.match(sig, /keyId="https:\/\/klonkt\.test\/ap\/users\/band#main-key"/);
  const signature = /signature="([^"]+)"/.exec(sig)[1];
  const u = new URL(acc.naar);
  const tekst = `(request-target): post ${u.pathname}\nhost: ${u.host}\ndate: ${acc.headers.get('date')}\ndigest: ${acc.headers.get('digest')}`;
  const { public_pem } = getOrCreateKeys('band');
  assert.equal(crypto.verify('sha256', Buffer.from(tekst), public_pem, Buffer.from(signature, 'base64')), true);
});

test('een Undo van die Follow haalt de luisteraar weer weg', async () => {
  assert.equal(luisteraars.isLuisteraar('band', VOLGER), true, 'uitgangspunt: hij luistert');
  const st = await AP.handleInbox({
    body: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${VOLGER}#undo-library`, type: 'Undo', actor: VOLGER,
      object: { id: `${VOLGER}#follow-library`, type: 'Follow', actor: VOLGER, object: 'https://klonkt.test/ap/users/band/library' },
    },
    headers: {}, get: () => undefined, socket: {},
  }, 'band', { id: VOLGER });
  assert.equal(st, 202);
  assert.equal(luisteraars.isLuisteraar('band', VOLGER), false);
});
