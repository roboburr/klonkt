// Authorized fetch (shaer-afq): een instance in Mastodons secure mode geeft zijn
// actor-document -- en dus zijn publieke sleutel -- alleen aan een ONDERTEKEND
// verzoek. Zonder die handtekening kregen we 401, vonden we geen sleutel, en
// wezen we elke correct ondertekende Follow van die instance af. Op boiert.eu
// bleven daardoor vier accounts eindeloos hangen.
//
// De fetch is hier gestubd: het gaat om de vraag OF er ondertekend wordt en of
// er wordt teruggevallen, niet om echte HTTP of crypto.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');

// IP-literals: safeFetch slaat de DNS-lookup over, dus de test blijft offline.
const OPEN_ACTOR = 'https://203.0.113.30/users/open';       // gewone instance
const SECURE_ACTOR = 'https://203.0.113.40/users/gesloten'; // authorized fetch

let verzoeken = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ondertekend = !!(opts.headers && (opts.headers.Signature || opts.headers.signature));
  verzoeken.push({ url: u, ondertekend });
  const doc = (id) => new Response(JSON.stringify({
    id, type: 'Person', preferredUsername: 'x', inbox: `${id}/inbox`,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----' },
  }), { status: 200, headers: { 'content-type': 'application/activity+json' } });

  if (u === OPEN_ACTOR) return doc(OPEN_ACTOR);
  // De kern van secure mode: onbetekend is het 401, ondertekend krijg je hem wel.
  if (u === SECURE_ACTOR) return ondertekend ? doc(SECURE_ACTOR) : new Response('unauthorized', { status: 401 });
  return new Response('not found', { status: 404 });
};

test('een actor achter authorized fetch wordt nu wél opgehaald', async () => {
  verzoeken = [];
  const actor = await AP.fetchActor(SECURE_ACTOR, { asSlug: 'me' });
  assert.ok(actor, 'de actor hoort binnen te komen');
  assert.equal(actor.id, SECURE_ACTOR);
  assert.ok(verzoeken.some((v) => v.url === SECURE_ACTOR && v.ondertekend), 'het verzoek hoort ondertekend te zijn');
});

test('zonder ondertekenaar blijft dezelfde actor onbereikbaar', async () => {
  // Dit is precies het oude gedrag, en het bewijst dat de stub echt onderscheid
  // maakt in plaats van altijd mee te werken.
  const actor = await AP.fetchActor(SECURE_ACTOR);
  assert.equal(actor, null);
});

test('een gewone instance blijft werken, ondertekend of niet', async () => {
  assert.ok(await AP.fetchActor(OPEN_ACTOR), 'onbetekend');
  assert.ok(await AP.fetchActor(OPEN_ACTOR, { asSlug: 'me' }), 'ondertekend');
});

test('een OPEN instance wordt NIET ondertekend opgehaald', () => {
  // De veiligheidskant van shaer-afq: verifyRequest haalt de keyId-URL op
  // voordat er iets geverifieerd is, en die URL komt uit een header die iedereen
  // mag sturen. Tekenden we standaard, dan kan een vreemde ons een ondertekend
  // verzoek naar een adres van zijn keuze laten sturen, met onze identiteit
  // eronder. Onbetekend eerst dus, en alleen tekenen als het anders niet lukt.
  verzoeken = [];
  return AP.fetchActor(OPEN_ACTOR, { asSlug: 'me' }).then((actor) => {
    assert.ok(actor);
    assert.equal(verzoeken.length, 1, 'één poging, geen tweede');
    assert.equal(verzoeken[0].ondertekend, false, 'en die was onbetekend');
  });
});

test('een document zonder sleutel telt als mislukt en leidt tot een ondertekende poging', async () => {
  // Sommige instances serveren onbetekend wel iets, maar zonder publicKey. Voor
  // een verificatie hebben we daar niets aan.
  const KAAL = 'https://203.0.113.50/users/kaal';
  const stubOrig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const ondertekend = !!(opts.headers && (opts.headers.Signature || opts.headers.signature));
    if (String(url) === KAAL) {
      verzoeken.push({ url: String(url), ondertekend });
      const body = ondertekend
        ? { id: KAAL, type: 'Person', publicKey: { id: `${KAAL}#k`, owner: KAAL, publicKeyPem: 'x' } }
        : { id: KAAL, type: 'Person' };   // kaal: geen sleutel
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/activity+json' } });
    }
    return stubOrig(url, opts);
  };
  verzoeken = [];
  const actor = await AP.fetchActor(KAAL, { asSlug: 'me' });
  globalThis.fetch = stubOrig;
  assert.ok(actor.publicKey && actor.publicKey.publicKeyPem, 'de ondertekende poging levert de sleutel');
  assert.deepEqual(verzoeken.map((v) => v.ondertekend), [false, true], 'eerst onbetekend, daarna pas ondertekend');
});

test('een onbekende actor blijft null, ondertekend of niet', async () => {
  assert.equal(await AP.fetchActor('https://203.0.113.99/users/weg', { asSlug: 'me' }), null);
});

test.after(() => { globalThis.fetch = echteFetch; });
