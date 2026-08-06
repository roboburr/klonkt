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

test('mislukt ondertekend ophalen, dan volgt de onbetekende poging alsnog', async () => {
  // Niet elke 401 komt van secure mode, en een instance die geen handtekening
  // verwacht mag er niet door stukgaan. OPEN_ACTOR antwoordt op allebei, dus we
  // meten dat er ECHT twee pogingen zijn wanneer de eerste niets oplevert.
  verzoeken = [];
  const stubOrig = globalThis.fetch;
  let eerste = true;
  globalThis.fetch = async (url, opts = {}) => {
    const ondertekend = !!(opts.headers && (opts.headers.Signature || opts.headers.signature));
    if (String(url) === OPEN_ACTOR && ondertekend && eerste) { eerste = false; return new Response('nee', { status: 500 }); }
    return stubOrig(url, opts);
  };
  const actor = await AP.fetchActor(OPEN_ACTOR, { asSlug: 'me' });
  globalThis.fetch = stubOrig;
  assert.ok(actor, 'de terugval hoort hem alsnog op te halen');
});

test('een onbekende actor blijft null, ondertekend of niet', async () => {
  assert.equal(await AP.fetchActor('https://203.0.113.99/users/weg', { asSlug: 'me' }), null);
});

test.after(() => { globalThis.fetch = echteFetch; });
