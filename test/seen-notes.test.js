// shaer-e9g: onthoud de URI van antwoorden die we al ontvangen.
//
// Antwoorden van accounts die je volgt komen gewoon binnen, ondertekend door de
// schrijver zelf. Ze horen niet in de Krant (belongsInTimeline weigert alles met
// een inReplyTo) en werden daarna nergens bewaard. Kwam er later een
// DOORGESTUURD antwoord op zo'n bericht, dan kende Klonkt de ouder niet en wees
// het af -- terwijl het die ouder wel degelijk had gehad. Op boiert ging daar 72%
// van het doorstuurverkeer op stuk.
//
// Wat hier bewaakt wordt is vooral de grens: onthouden gebeurt ALLEEN voor
// schrijvers die je zelf volgt. Zou dat voor iedereen gelden, dan kan een vreemde
// eerst een bericht neerleggen en daarna met een antwoord daarop de dereference
// naar een adres van zijn keuze sturen.
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

// IP-literals: safeFetch slaat de DNS-lookup over, dus offline.
const GEVOLGD = 'https://203.0.113.10/users/catsalad';     // volgen we
const VREEMDE = 'https://203.0.113.90/users/onbekend';     // volgen we niet
const DOORSTUURDER = 'https://203.0.113.20/users/relay';

db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, status) VALUES (?,?,?,?)`)
  .run('me', GEVOLGD, '@catsalad@203.0.113.10', 'accepted');

let bron = null;
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (bron && bron.id === u) {
    return new Response(JSON.stringify(bron), { status: 200, headers: { 'content-type': 'application/activity+json' } });
  }
  return new Response('not found', { status: 404 });
};

const req = (body) => ({ body, headers: { signature: 'keyId="x",signature="y"' }, ip: '203.0.113.9' });
const gezien = (uri) => !!db.prepare('SELECT 1 FROM ap_seen_notes WHERE uri = ?').get(uri);

/** Een gewoon bezorgd antwoord: ondertekend door de schrijver zelf. */
function bezorgdAntwoord(auteur, id, inReplyTo) {
  return {
    type: 'Create',
    actor: auteur,
    object: {
      id, type: 'Note', attributedTo: auteur, inReplyTo,
      content: '<p>een antwoord midden in een draad</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

test('een antwoord van iemand die we volgen wordt onthouden', async () => {
  const uri = 'https://203.0.113.10/notes/catsalad-1';
  const status = await AP.handleInbox(req(bezorgdAntwoord(GEVOLGD, uri, 'https://203.0.113.10/notes/draad-start')), 'me', { id: GEVOLGD });
  assert.equal(status, 202);
  assert.ok(gezien(uri), 'de URI hoort bewaard te zijn');
});

test('maar het verschijnt NIET in de Krant', () => {
  // Alleen de URI. Er verandert niets aan wat je te zien krijgt -- een antwoord
  // hoort in zijn draad, niet in de tijdlijn, en dat blijft zo.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ap_timeline').get().n, 0);
});

test('een antwoord van een VREEMDE wordt niet onthouden', async () => {
  const uri = 'https://203.0.113.90/notes/vreemde-1';
  await AP.handleInbox(req(bezorgdAntwoord(VREEMDE, uri, 'https://203.0.113.90/notes/iets')), 'me', { id: VREEMDE });
  assert.equal(gezien(uri), false, 'anders kan een vreemde de poort voor zichzelf openzetten');
});

test('een gewone POST van iemand die we volgen wordt niet als gezien-antwoord bewaard', async () => {
  // Die gaat naar de Krant en staat daarmee al in ap_timeline; een tweede
  // administratie zou alleen maar uiteen kunnen lopen.
  const uri = 'https://203.0.113.10/notes/gewone-post';
  const act = bezorgdAntwoord(GEVOLGD, uri, null);
  delete act.object.inReplyTo;
  await AP.handleInbox(req(act), 'me', { id: GEVOLGD });
  assert.equal(gezien(uri), false);
  assert.ok(db.prepare('SELECT 1 FROM ap_timeline WHERE id = ?').get(uri), 'die hoort juist wel in de Krant');
});

test('en dan komt het doorgestuurde antwoord OP dat bericht wel binnen', async () => {
  // De hele reden van deze bead. Zonder het onthouden was dit een afwijzing met
  // "skipped (unknown inReplyTo)".
  const ouder = 'https://203.0.113.10/notes/catsalad-1';   // hierboven onthouden
  const antwoord = 'https://203.0.113.30/notes/drinkcoaster-1';
  const schrijver = 'https://203.0.113.30/users/drinkcoaster';
  bron = {
    id: antwoord, type: 'Note', attributedTo: schrijver, inReplyTo: ouder,
    content: '<p>ECHTE versie</p>', to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
  const act = { type: 'Create', actor: schrijver, object: { ...bron, content: '<p>BEZORGDE versie</p>' } };
  const status = await AP.handleInbox(req(act), 'me', { id: DOORSTUURDER });
  assert.equal(status, 202, 'de doorgestuurde Create hoort geaccepteerd te worden');
});

test('een doorgestuurd antwoord op een bericht dat we NIET kenden blijft geweigerd', async () => {
  const antwoord = 'https://203.0.113.30/notes/drinkcoaster-2';
  const schrijver = 'https://203.0.113.30/users/drinkcoaster';
  bron = {
    id: antwoord, type: 'Note', attributedTo: schrijver, inReplyTo: 'https://203.0.113.90/notes/nooit-gezien',
    content: '<p>x</p>', to: ['https://www.w3.org/ns/activitystreams#Public'],
  };
  const act = { type: 'Create', actor: schrijver, object: bron };
  assert.equal(await AP.handleInbox(req(act), 'me', { id: DOORSTUURDER }), 401);
});

test.after(() => { globalThis.fetch = echteFetch; });
