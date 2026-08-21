// Oppikken en afhandelen van een hulpvraag (shaer-lgo).
//
// Een hulpvraag gaat naar ALLE guardians van een kind, op verschillende servers.
// Zonder gedeelde staat denken er twee dat de ander het oppakt -- en dat is
// precies het scenario waar de reddingsboei voor bestaat.
//
// DE FAALSTAND IS HIER NIET VEILIG. Bij een gate is 'dicht' het veilige
// antwoord; hier is de faalstand 'iedereen denkt dat het geregeld is', en dat is
// gevaarlijker dan geen markering. Vandaar dat de meeste tests hieronder gaan
// over wat er gebeurt als er IETS niet klopt: dan hoort de hulpvraag OPEN te
// staan.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const help = await import('../src/services/guardianship/help.js');

const NOTE = 'https://kind.test/ap/notes/hulp-1';
const OMA = 'https://oma.test/ap/users/oma';
const OPA = 'https://opa.test/ap/users/opa';

test('een verse hulpvraag staat open', () => {
  const s = help.statusOf(NOTE);
  assert.equal(s.open, true);
  assert.deepEqual(s.pickedUpBy, []);
  assert.equal(s.handled, null);
});

test('oppikken mag STAPELEN', () => {
  // Twee mensen die tegelijk reageren op een kind dat om hulp vraagt is geen
  // probleem. Twee die allebei niets doen omdat de ander het geclaimd had, wel.
  help.record(NOTE, OMA, 'pickup', '@oma@oma.test');
  help.record(NOTE, OPA, 'pickup', '@opa@opa.test');
  const s = help.statusOf(NOTE);
  assert.equal(s.pickedUpBy.length, 2);
  assert.equal(s.open, true, 'opgepikt is nog niet afgehandeld');
});

test('en het staat erbij DOOR WIE, want dat was de hele vraag', () => {
  const s = help.statusOf(NOTE);
  assert.ok(s.pickedUpBy.some((p) => p.handle === '@oma@oma.test'));
  assert.ok(s.pickedUpBy.every((p) => p.at), 'met een tijdstip, anders kun je niet zien dat het oud wordt');
});

test('twee keer hetzelfde oppikken telt een keer', () => {
  help.record(NOTE, OMA, 'pickup', '@oma@oma.test');
  assert.equal(help.statusOf(NOTE).pickedUpBy.length, 2);
});

test('een oppik VERVALT NIET maar veroudert wel zichtbaar', () => {
  // Barts keuze: niets verdwijnt, want een signaal dat wegvalt laat een
  // hulpvraag er onaangeroerd uitzien terwijl er iemand mee bezig is. Het scherm
  // toont in plaats daarvan hoe oud het is.
  const rijen = [{ kind: 'pickup', guardian_uri: OMA, created_at: '2026-08-05T10:00:00.000Z' }];
  const s = help.helpStatus(rijen, Date.parse('2026-08-07T10:00:00.000Z'));
  assert.equal(s.open, true);
  // Een TIJDSTIP, geen leeftijd: een verschil met `now` maakt het antwoord elke
  // milliseconde anders, en dan kan de ETag van het paneel nooit gelijk zijn --
  // dat leverde een lus op waarin de browser zichzelf bleef verversen.
  assert.equal(s.oldestPickupAt, '2026-08-05T10:00:00.000Z');
});

test('afhandelen sluit hem, met naam', () => {
  help.record(NOTE, OPA, 'handled', '@opa@opa.test');
  const s = help.statusOf(NOTE);
  assert.equal(s.open, false);
  assert.equal(s.handled.handle, '@opa@opa.test');
  assert.equal(s.oldestPickupAt, null, 'het tijdstip van een oppik zegt niets meer als het klaar is');
});

test('er is GEEN terugdraai', () => {
  // Besluit van Bart: sluiten gebeurt met een stevige bevestiging, en leeft de
  // vraag daarna nog, dan wordt hij OPNIEUW GESTELD -- een nieuwe hulpvraag. Er
  // wordt niets herschreven.
  assert.equal(typeof help.default.undo, 'undefined');
  assert.equal(typeof help.default.reopen, 'undefined');
});

test('bij twijfel staat een hulpvraag OPEN', () => {
  // Alles wat geen expliciete afsluiting is telt als open. Een lege lijst, rommel,
  // een onbekende soort: allemaal 'er wacht nog iemand'. De omgekeerde fout --
  // iets als afgehandeld tonen dat het niet is -- is de gevaarlijke.
  for (const rijen of [[], null, [{ kind: 'iets', guardian_uri: OMA }], [{ kind: 'pickup', guardian_uri: OMA }]]) {
    assert.equal(help.helpStatus(rijen).open, true);
  }
});

test('een markering wordt herkend, en iets anders niet', () => {
  assert.deepEqual(help.parseMarker({ 'shaer:helpPickup': NOTE }), { kind: 'pickup', noteUri: NOTE });
  assert.deepEqual(help.parseMarker({ 'shaer:helpHandled': NOTE }), { kind: 'handled', noteUri: NOTE });
  assert.equal(help.parseMarker({ content: '<p>hoi</p>' }), null);
  assert.equal(help.parseMarker(null), null);
  assert.equal(help.parseMarker({ 'shaer:helpPickup': '' }), null, 'leeg is geen markering');
});

test('afhandelen wint van oppikken in hetzelfde bericht', () => {
  // Kan niet ontstaan uit onze eigen verzending, maar wel uit een andere
  // implementatie. Het zwaarste signaal telt.
  assert.equal(help.parseMarker({ 'shaer:helpPickup': NOTE, 'shaer:helpHandled': NOTE }).kind, 'handled');
});

test('een lijst hulpvragen kost EEN query', () => {
  const N2 = 'https://kind.test/ap/notes/hulp-2';
  help.record(N2, OMA, 'pickup', '@oma@oma.test');
  const m = help.statusFor([NOTE, N2, 'https://kind.test/ap/notes/leeg']);
  assert.equal(m.size, 3);
  assert.equal(m.get(NOTE).open, false);
  assert.equal(m.get(N2).pickedUpBy.length, 1);
  assert.equal(m.get('https://kind.test/ap/notes/leeg').open, true, 'onbekend is open');
});

test('een hulpvraag van een OUD-ward staat niet meer open', () => {
  // Het loslaat-scherm belooft dit al: "je krijgt geen hulpvragen meer van ze".
  // Nieuwe komen niet meer binnen, maar wat er al lag bleef staan -- en was niet
  // af te sluiten, want de markeerroute eist dat het nog je ward is.
  const st = help.withWardship(help.helpStatus([]), false);
  assert.equal(st.open, false);
  assert.equal(st.formerWard, true);
});

test('maar hij is NIET afgehandeld', () => {
  // Dat zou een claim zijn over een kind waar je niets meer over te zeggen hebt,
  // en die claim wordt ook nog rondgestuurd naar de andere guardians. Er is een
  // derde uitkomst: niet meer van jou.
  const st = help.withWardship(help.helpStatus([]), false);
  assert.equal(st.handled, null);
});

test('een lopende oppik blijft leesbaar als je losgelaten hebt', () => {
  // Je was erbij. Dat je nu geen guardian meer bent maakt niet dat het nooit
  // gebeurd is -- de geschiedenis hoort te kloppen.
  const rijen = [{ kind: 'pickup', guardian_uri: OMA, guardian_handle: '@oma', created_at: '2026-08-05T10:00:00.000Z' }];
  const st = help.withWardship(help.helpStatus(rijen, Date.parse('2026-08-05T11:00:00.000Z')), false);
  assert.equal(st.pickedUpBy.length, 1);
  assert.equal(st.pickedUpBy[0].handle, '@oma');
});

test('zolang het WEL je ward is verandert er niets', () => {
  const rijen = [{ kind: 'pickup', guardian_uri: OMA, guardian_handle: '@oma', created_at: '2026-08-05T10:00:00.000Z' }];
  const basis = help.helpStatus(rijen, Date.parse('2026-08-05T11:00:00.000Z'));
  assert.deepEqual(help.withWardship(basis, true), basis);
});

test('het antwoord verandert NIET als je het twee keer opvraagt', () => {
  // De fout die Barts browser in een lus bracht (9-8): hier stond ageMs, een
  // verschil met `now`. Daardoor was elk antwoord anders, kon de ETag van het
  // paneel nooit gelijk zijn, kwam de 304 nooit, en keerde de lange poll meteen
  // terug -- inclusief een hertekening die de scrollpositie vermaalde.
  //
  // Een levende klok in een antwoord maakt dat antwoord onvergelijkbaar met
  // zichzelf. Deze toets bewaakt precies dat.
  const rijen = [{ kind: 'pickup', guardian_uri: OMA, created_at: '2026-08-05T10:00:00.000Z' }];
  const a = JSON.stringify(help.helpStatus(rijen, Date.parse('2026-08-05T12:00:00.000Z')));
  const b = JSON.stringify(help.helpStatus(rijen, Date.parse('2026-08-05T12:00:00.500Z')));
  assert.equal(a, b, 'een halve seconde later is hetzelfde antwoord');
});
