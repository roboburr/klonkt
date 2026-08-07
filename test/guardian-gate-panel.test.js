// Het gate-paneel per ward (shaer-ahy.1).
//
// Wat gated wordt is een ontwerpkeuze van de implementatie -- de FEP levert het
// mechanisme en een paar voorbeelden, niet de lijst. GATE_CATALOGUE is die lijst
// op een plek, en gateRows maakt er de rijen van die het paneel toont.
//
// De regels die hier bewaakt worden zijn geen opmaak maar betekenis: een gate
// die je niet kunt verzetten hoort tOch zichtbaar te zijn, onbekend is niet uit,
// en er wordt geen drempel verzonnen die we niet kennen.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const gated = await import('../src/services/guardianship/gated.js');

const rij = (rows, f) => rows.find((r) => r.feature === f);

test('elke gate uit de catalogus krijgt een rij, ook de vaste', () => {
  // Een paneel dat alleen verstelbare dingen toont verzwijgt de helft van wat er
  // voor dit kind geldt.
  const rows = gated.gateRows({});
  assert.equal(rows.length, gated.GATE_CATALOGUE.length);
  assert.ok(rij(rows, 'shaer:follows'), 'volgverzoeken zijn altijd gated en horen er tOch te staan');
  assert.equal(rij(rows, 'shaer:follows').adjustable, false, 'maar niet te verzetten');
});

test('het soort staat erbij, want ze werken niet hetzelfde', () => {
  const rows = gated.gateRows({});
  assert.equal(rij(rows, 'shaer:externalEmbeds').kind, 'setting');
  assert.equal(rij(rows, 'shaer:follows').kind, 'perRequest');
});

test('de drempel volgt het aantal guardians', () => {
  const drie = gated.gateRows({ guardianCount: 3 });
  assert.deepEqual(rij(drie, 'shaer:externalEmbeds').threshold, { need: 2, of: 3 });
  const een = gated.gateRows({ guardianCount: 1 });
  assert.deepEqual(rij(een, 'shaer:externalEmbeds').threshold, { need: 1, of: 1 });
});

test('een ONBEKEND aantal guardians levert GEEN drempel op', () => {
  // Bij een ward elders wordt die set op diens eigen server bijgehouden. Een
  // verzonnen getal leest als een feit, en dit is precies waar een guardian op
  // afgaat voordat hij iets voorstelt.
  const rows = gated.gateRows({ guardianCount: null });
  assert.equal(rij(rows, 'shaer:externalEmbeds').threshold, null);
});

test('afspelen is dicht zolang zien UIT staat', () => {
  const rows = gated.gateRows({ settings: { 'shaer:externalEmbeds': false } });
  const p = rij(rows, 'shaer:externalPlayback');
  assert.equal(p.adjustable, false);
  assert.equal(p.blockedBy, 'shaer:externalEmbeds');
});

test('maar ONBEKEND is niet hetzelfde als uit', () => {
  // Verbergen bij onbekend betekende ooit dat een guardian elders afspelen nooit
  // kon voorstellen -- daar ging een hele voorstelronde de verkeerde gate in.
  const rows = gated.gateRows({ settings: { 'shaer:externalEmbeds': null } });
  const p = rij(rows, 'shaer:externalPlayback');
  assert.equal(p.adjustable, true);
  assert.equal(p.blockedBy, undefined);
});

test('een lopend voorstel hangt aan zijn eigen gate', () => {
  const rows = gated.gateRows({
    proposals: [{ feature: 'shaer:externalPlayback', value: true, status: 'open' }],
  });
  assert.equal(rij(rows, 'shaer:externalPlayback').proposal.status, 'open');
  assert.equal(rij(rows, 'shaer:externalEmbeds').proposal, undefined);
});

test('wat er wacht staat bij de gate waar het op wacht', () => {
  const rows = gated.gateRows({ waiting: { 'shaer:follows': 2 } });
  assert.equal(rij(rows, 'shaer:follows').waiting, 2);
});

test('omkeerbaarheid staat per gate genoteerd', () => {
  // Nu is alles omkeerbaar. Zodra independence erbij komt (shaer-90v) is dat het
  // niet, en dan moet het paneel dat kunnen zeggen zonder verbouwing.
  for (const r of gated.gateRows({})) assert.equal(typeof r.reversible, 'boolean');
});
