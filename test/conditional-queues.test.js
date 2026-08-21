// Stilte hoort niets te kosten (Barts punt, 9-8).
//
// De inbox doet dit al met `since` + `wait`: niets veranderd is een 304. De
// guardian-wachtrijen stuurden bij elke verversing de hele lijst terug -- bij
// honderd wards veertienhonderd objecten die de telefoon opnieuw moet opbouwen.
//
// Wat hier bewaakt wordt: dat de ETag over de INHOUD gaat (verandert er iets,
// dan verandert hij mee) en dat een leeg antwoord NOOIT een 304 oplevert. Dat
// tweede is dezelfde les als de '0'-uitzondering bij de inbox: gaat er iets mis
// bij het opbouwen, dan is de hash van niets ook stabiel, en zit een client voor
// eeuwig op 304 te kijken naar een leeg scherm.
//
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const AP = await import('../src/services/ActivityPubService.js');

function nepRes() {
  return {
    code: 200, body: null, headers: {},
    set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    type(t) { this.headers['content-type'] = t; return this; },
    status(c) { this.code = c; return this; },
    end() { this.body = ''; return this; },
    send(b) { this.body = b; return this; },
  };
}
const req = (etag) => ({ headers: etag ? { 'if-none-match': etag } : {} });
const coll = (n) => ({ type: 'OrderedCollection', orderedItems: Array.from({ length: n }, (_, i) => ({ id: `x${i}` })) });

test('dezelfde inhoud levert de tweede keer een 304 op', () => {
  const r1 = nepRes();
  AP.sendMaybe304(req(), r1, coll(3));
  assert.equal(r1.code, 200);
  assert.ok(r1.headers.etag, 'er is een merksteen');

  const r2 = nepRes();
  AP.sendMaybe304(req(r1.headers.etag), r2, coll(3));
  assert.equal(r2.code, 304);
  assert.equal(r2.body, '', 'en geen inhoud');
});

test('verandert er iets, dan verandert de merksteen mee', () => {
  const r1 = nepRes(); AP.sendMaybe304(req(), r1, coll(3));
  const r2 = nepRes(); AP.sendMaybe304(req(r1.headers.etag), r2, coll(4));
  assert.equal(r2.code, 200, 'vier items is niet drie');
  assert.notEqual(r2.headers.etag, r1.headers.etag);
});

test('een LEEG antwoord krijgt nooit een 304', () => {
  // De gevaarlijke stille fout: gaat het opbouwen mis en komt er een lege lijst
  // uit, dan is die hash ook stabiel en kijkt een client voor eeuwig naar niets.
  const r1 = nepRes();
  AP.sendMaybe304(req(), r1, coll(0));
  assert.equal(r1.code, 200);
  assert.equal(r1.headers.etag, undefined, 'geen merksteen op leegte');

  const r2 = nepRes();
  AP.sendMaybe304(req('"wat-dan-ook"'), r2, coll(0));
  assert.equal(r2.code, 200, 'en dus ook nooit een 304');
});

test('de client krijgt te horen dat hij mag bewaren en moet navragen', () => {
  // Zonder no-cache stuurt een browser geen If-None-Match, en is de ETag
  // decoratie. En Vary op Authorization, want dit is een eigenaar-antwoord.
  const r = nepRes();
  AP.sendMaybe304(req(), r, coll(2));
  assert.match(r.headers['cache-control'], /no-cache/);
  assert.equal(r.headers.vary, 'Authorization');
});

test('een antwoord dat geen collectie is werkt ook', () => {
  // Het paneel is geen OrderedCollection maar een gewoon object.
  const r1 = nepRes(); AP.sendMaybe304(req(), r1, { wards: [], strings: { a: 'b' } });
  const r2 = nepRes(); AP.sendMaybe304(req(r1.headers.etag), r2, { wards: [], strings: { a: 'b' } });
  assert.equal(r2.code, 304);
});
