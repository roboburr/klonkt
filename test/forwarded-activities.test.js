// Doorgestuurde activiteiten (shaer-s8k): een geldige handtekening van iemand
// anders dan de auteur is doorsturen, geen vervalsing. We geloven de bezorgde
// inhoud niet en halen het object bij de bron op.
//
// Deze tests dekken dereferenceForwarded via de echte handleInbox, met een
// gestubde fetch: het gaat om de BESLISSING (accepteren of weigeren) en om wat
// er wordt opgeslagen, niet om HTTP.
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

// IP-literals uit de documentatierange (TEST-NET-3): safeFetch doet dan GEEN
// DNS-lookup (zie assertPublicHost) en ze staan niet in de geblokkeerde ranges,
// dus de SSRF-preflight laat ze door en de gestubde fetch vangt het verzoek op.
// Met verzonnen hostnamen faalde de preflight en kwam het nooit tot ophalen.
const AUTEUR = 'https://203.0.113.10/users/anna';
const DOORSTUURDER = 'https://203.0.113.20/users/relay';
const NOTE_ID = 'https://203.0.113.10/notes/1';

// Wat de bron teruggeeft als we het object ophalen. Per test aan te passen.
let bron = null;
let opgehaald = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  opgehaald.push(u);
  if (u === NOTE_ID && bron) {
    return new Response(JSON.stringify(bron), { status: 200, headers: { 'content-type': 'application/activity+json' } });
  }
  return new Response('not found', { status: 404 });
};

/** Een doorgestuurde Create: ondertekend door de doorstuurder, geschreven door de auteur. */
function doorgestuurd(objectOverride) {
  return {
    type: 'Create',
    actor: AUTEUR,
    object: objectOverride !== undefined ? objectOverride : {
      id: NOTE_ID, type: 'Note', attributedTo: AUTEUR,
      content: '<p>BEZORGDE versie</p>', to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}
const req = (body) => ({ body, headers: { signature: 'keyId="x",signature="y"' }, ip: '203.0.113.9' });
const alsDoorstuurder = { id: DOORSTUURDER };

test('doorgestuurde Create wordt geaccepteerd na ophalen bij de bron', async () => {
  bron = { id: NOTE_ID, type: 'Note', attributedTo: AUTEUR, content: '<p>ECHTE versie</p>' };
  opgehaald = [];
  const act = doorgestuurd();
  const status = await AP.handleInbox(req(act), 'me', alsDoorstuurder);
  assert.notEqual(status, 401, 'een doorgestuurde reactie hoort niet meer geweigerd te worden');
  assert.ok(opgehaald.includes(NOTE_ID), 'het object hoort bij de bron opgehaald te zijn');
  // Wat telt: de OPGEHAALDE inhoud wordt gebruikt, niet wat de doorstuurder gaf.
  assert.match(act.object.content, /ECHTE versie/);
  assert.doesNotMatch(act.object.content, /BEZORGDE/);
});

test('een doorstuurder die de inhoud verdraait wint daar niets mee', async () => {
  // Hetzelfde echte id, maar de bezorgde payload liegt over de inhoud. De bron
  // is de waarheid; de payload wordt weggegooid.
  bron = { id: NOTE_ID, type: 'Note', attributedTo: AUTEUR, content: '<p>ECHTE versie</p>' };
  const act = doorgestuurd({ id: NOTE_ID, type: 'Note', attributedTo: AUTEUR, content: '<p>KOOP MIJN MUNTEN</p>' });
  await AP.handleInbox(req(act), 'me', alsDoorstuurder);
  assert.doesNotMatch(act.object.content, /MUNTEN/);
});

test('object op een ANDERE host dan de geclaimde actor wordt geweigerd', async () => {
  // Zonder deze ankereis wijst een doorsturer je naar een host die hij zelf
  // beheert, waar attributedTo alles kan beweren.
  bron = { id: 'https://203.0.113.66/notes/1', type: 'Note', attributedTo: AUTEUR, content: '<p>x</p>' };
  const act = doorgestuurd({ id: 'https://203.0.113.66/notes/1', type: 'Note', attributedTo: AUTEUR, content: '<p>x</p>' });
  const status = await AP.handleInbox(req(act), 'me', alsDoorstuurder);
  assert.equal(status, 401);
});

test('de bron die het object NIET aan de geclaimde actor toeschrijft → geweigerd', async () => {
  bron = { id: NOTE_ID, type: 'Note', attributedTo: 'https://203.0.113.10/users/iemandanders', content: '<p>x</p>' };
  const status = await AP.handleInbox(req(doorgestuurd()), 'me', alsDoorstuurder);
  assert.equal(status, 401);
});

test('bron onbereikbaar → geweigerd, geen twijfelgeval opgeslagen', async () => {
  bron = null;   // de stub geeft 404
  const status = await AP.handleInbox(req(doorgestuurd()), 'me', alsDoorstuurder);
  assert.equal(status, 401);
});

test('een doorgestuurde Delete blijft geweigerd', async () => {
  // Niet te dereferencen: het object is per definitie weg.
  bron = { id: NOTE_ID, type: 'Note', attributedTo: AUTEUR };
  const act = { type: 'Delete', actor: AUTEUR, object: NOTE_ID };
  const status = await AP.handleInbox(req(act), 'me', alsDoorstuurder);
  assert.equal(status, 401);
});

test('een ONGETEKENDE activiteit blijft geweigerd, ook met een geldig object', async () => {
  // Zonder bewijs van wie het bezorgde is er niets om op te bouwen; dan mag er
  // ook niet gedereferenced worden.
  bron = { id: NOTE_ID, type: 'Note', attributedTo: AUTEUR, content: '<p>x</p>' };
  opgehaald = [];
  const status = await AP.handleInbox({ body: doorgestuurd(), headers: {}, ip: '203.0.113.9' }, 'me', null);
  assert.equal(status, 401);
  assert.equal(opgehaald.includes(NOTE_ID), false, 'er hoort niet eens opgehaald te worden');
});

test('een object-id dat naar iets anders omleidt wordt geweigerd', async () => {
  // De bron geeft een ander id terug dan we opvroegen: dan weten we niet wat we
  // in handen hebben.
  bron = { id: 'https://203.0.113.10/notes/999', type: 'Note', attributedTo: AUTEUR, content: '<p>x</p>' };
  const status = await AP.handleInbox(req(doorgestuurd()), 'me', alsDoorstuurder);
  assert.equal(status, 401);
});

test.after(() => { globalThis.fetch = echteFetch; });
