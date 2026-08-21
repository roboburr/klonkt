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

test('de stand komt uit de BESLUITEN, en zegt of er wel besloten is', () => {
  // Er zijn geen lokale accounts: elke ward woont elders, dus de kolom op onze
  // eigen sites-tabel is voor iedere ward leeg. Wat een guardian wel heeft is de
  // uitslag van wat hij voorstelde.
  const aan = gated.gateRows({ settings: { 'shaer:externalEmbeds': { value: true, decided: true } } });
  assert.equal(rij(aan, 'shaer:externalEmbeds').value, true);
  assert.equal(rij(aan, 'shaer:externalEmbeds').decided, true);
});

test('nooit besloten is iets anders dan besloten-uit', () => {
  // "Uit" en "voor zover wij weten uit" zijn niet hetzelfde. Dat tweede als een
  // besluit tonen suggereert dat iemand het genomen heeft.
  const r = rij(gated.gateRows({ settings: { 'shaer:externalEmbeds': { value: false, decided: false } } }), 'shaer:externalEmbeds');
  assert.equal(r.value, false);
  assert.equal(r.decided, false);
});

test('de trap blokkeert alleen op een BESLOTEN dicht', () => {
  // Blokkeren op de standaard zou betekenen dat afspelen nooit als eerste
  // voorgesteld kan worden -- en zo ging er ooit een hele voorstelronde de
  // verkeerde gate in.
  const standaard = gated.gateRows({ settings: { 'shaer:externalEmbeds': { value: false, decided: false } } });
  assert.equal(rij(standaard, 'shaer:externalPlayback').adjustable, true);
  const beslist = gated.gateRows({ settings: { 'shaer:externalEmbeds': { value: false, decided: true } } });
  assert.equal(rij(beslist, 'shaer:externalPlayback').adjustable, false);
});

test('de oude vorm (kale boolean) blijft werken', () => {
  // Backwards: een aanroeper die nog true/false doorgeeft hoort niet om te vallen.
  const r = rij(gated.gateRows({ settings: { 'shaer:externalEmbeds': true } }), 'shaer:externalEmbeds');
  assert.equal(r.value, true);
  assert.equal(r.decided, true);
});

test('omkeerbaarheid staat per gate genoteerd', () => {
  // Nu is alles omkeerbaar. Zodra independence erbij komt (shaer-90v) is dat het
  // niet, en dan moet het paneel dat kunnen zeggen zonder verbouwing.
  for (const r of gated.gateRows({})) assert.equal(typeof r.reversible, 'boolean');
});

// ── De waarschuwing bij een voorstel (shaer-nf9) ────────────────────────

test('een gewone gate waarschuwt omkeerbaar, niet onomkeerbaar', () => {
  // Barts zin "een geopende poort gaat niet meer dicht" klopt niet over de
  // INSTELLING -- die gaat wel weer dicht. Zo'n aantoonbaar onware waarschuwing
  // neemt de rest van het scherm mee in zijn val zodra iemand het merkt.
  assert.equal(gated.gateConsequence('shaer:externalEmbeds'), 'reversible');
});

test('independence waarschuwt WEL onomkeerbaar', () => {
  // De enige die gezag overdraagt (shaer-90v). Daar is Barts zin wel waar.
  assert.equal(gated.gateConsequence('shaer:independence'), 'irreversible');
});

test('een gate die we NIET kennen krijgt de zwaarste tekst', () => {
  // Een mede-guardian elders kan iets voorstellen dat onze catalogus niet kent.
  // Bij twijfel waarschuwen we zwaarder, niet lichter: de faalstand die hier pijn
  // doet is een guardian die iets doorlaat omdat het scherm er licht over deed.
  assert.equal(gated.gateConsequence('shaer:ietsNieuws'), 'unknown');
});

test('elke gate uit de catalogus levert een gevolg op', () => {
  // Anders valt er stilletjes een rij zonder waarschuwing door.
  for (const g of gated.GATE_CATALOGUE) {
    assert.ok(['reversible', 'irreversible'].includes(gated.gateConsequence(g.feature)), g.feature);
  }
});

// ── Dezelfde poorten voor het paneel en voor de apps (shaer-ahy.1) ───────

test('de wards-queue draagt de poorten mee', async () => {
  // Zonder dit kon een app een ward wel TONEN maar niets over hem zeggen. De
  // apps lezen deze collectie; het PWA-paneel leest wardGates rechtstreeks.
  const q = await import('../src/services/guardianship/queues.js');
  const rel = await import('../src/services/guardianship/relations.js');
  const dbm = await import('../src/config/database.js');
  dbm.initializeDatabase();
  dbm.default.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('gu', 'gu', 'gu@t', 'x', 'god');
  dbm.default.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('gs', 'oma', 'Oma', 'gu');
  rel.commitWardForGuardian('oma', 'https://elders/ap/users/kind', { handle: '@kind' });

  const coll = q.wardsCollection('https://x/queues/wards', 'oma');
  const ward = coll.orderedItems.find((w) => w.id === 'https://elders/ap/users/kind');
  assert.ok(ward, 'de ward staat in de collectie');
  assert.ok(Array.isArray(ward['shaer:gates']), 'en draagt zijn poorten');
  assert.equal(ward['shaer:gates'].length, gated.GATE_CATALOGUE.length);
});

test('de app krijgt PRECIES dezelfde rijen als het paneel', async () => {
  // Twee berekeningen naast elkaar geven vroeg of laat een ander antwoord op
  // dezelfde vraag, en dat is hier geen schoonheidsfoutje: dan krijgen twee
  // guardians een verschillend beeld van hetzelfde kind.
  const q = await import('../src/services/guardianship/queues.js');
  const coll = q.wardsCollection('https://x/queues/wards', 'oma');
  const uitQueue = coll.orderedItems.find((w) => w.id === 'https://elders/ap/users/kind')['shaer:gates'];
  const uitPaneel = q.wardGates('oma', 'https://elders/ap/users/kind');
  assert.deepEqual(uitQueue, uitPaneel);
});
