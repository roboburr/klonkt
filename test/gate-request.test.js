// Een kind dat zelf om een poort vraagt (shaer-8ru, Barts opdracht 8-8).
//
// Tot nu toe liep alles over de guardians: zij zien de catalogus, zij stellen
// voor, zij tellen. Het kind liep tegen een dichte deur en had geen woorden.
//
// De twee dingen die hier stil kunnen breken zijn allebei erg:
//   - een VRAAG die als STEM telt: dan opent een kind zijn eigen poort door
//     hard genoeg te vragen;
//   - een vraag die door de reddingsboei loopt: dan devalueert de boei tot
//     "het kind wil iets", en kijkt er op een dag niemand meer op als hij afgaat.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://oma.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const Guardianship = await import('../src/services/guardianship/index.js');
const gatereq = await import('../src/services/guardianship/gatereq.js');
const rel = await import('../src/services/guardianship/relations.js');
const queues = await import('../src/services/guardianship/queues.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'oma', 'Oma', 'u1');
const KIND = 'https://elders.test/ap/users/kind';
rel.commitWardForGuardian('oma', KIND, { handle: '@kind' });

test('een verzoek van een eigen ward wordt bewaard', () => {
  gatereq.record('oma', KIND, 'shaer:images', 'https://elders.test/ap/notes/1');
  const open = gatereq.listOpen('oma');
  assert.equal(open.length, 1);
  assert.equal(open[0].feature, 'shaer:images');
});

test('een VRAAG is geen STEM', () => {
  // De grens van dit hele bead. Een verzoek mag nergens als voorstel of als
  // stem opduiken: anders opent een kind zijn eigen poort door te vragen.
  assert.equal(Guardianship.gated.listSent('oma', KIND).length, 0);
  const rij = queues.wardGates('oma', KIND).find((g) => g.feature === 'shaer:images');
  assert.equal(rij.proposal, undefined, 'geen voorstel');
  assert.notEqual(rij.value, true, 'en zeker geen open poort');
});

test('de vraag staat BIJ de poort waar hij over gaat', () => {
  // Niet in een aparte lijst die je apart moet openen, en dus vergeet.
  const rij = queues.wardGates('oma', KIND).find((g) => g.feature === 'shaer:images');
  assert.equal(rij.requested, 1);
});

test('en NIET op een hoop met de wachtrij', () => {
  // Drie onbekenden die je kind willen volgen is iets heel anders dan je kind
  // dat een keer vraagt of muziek aan mag. Een gedeeld getal maakt daar
  // hetzelfde van, en dan leest de ene urgentie als de andere.
  const rij = queues.wardGates('oma', KIND).find((g) => g.feature === 'shaer:images');
  assert.equal(rij.waiting, undefined);
});

test('afgehandeld verdwijnt uit het zicht maar niet uit de geschiedenis', () => {
  // Er wordt niets herschreven, er wordt toegevoegd -- zelfde regel als bij de
  // hulpvraag: wat een kind gevraagd heeft hoort terug te vinden te zijn, ook
  // als het antwoord nee was.
  gatereq.markHandled('oma', KIND, 'shaer:images');
  assert.equal(gatereq.listOpen('oma').length, 0);
  const alles = db.prepare('SELECT * FROM ap_gate_requests WHERE ward_uri = ?').all(KIND);
  assert.equal(alles.length, 1);
  assert.ok(alles[0].handled_at, 'met een stempel erop');
});

test('een verzoek zonder feature is geen verzoek', () => {
  assert.equal(gatereq.parseRequest({ content: 'hoi' }), null);
  assert.equal(gatereq.parseRequest({ 'shaer:gateRequest': '' }), null);
  assert.deepEqual(gatereq.parseRequest({ 'shaer:gateRequest': 'shaer:music' }), { feature: 'shaer:music' });
});

test('het verzoek draagt GEEN vrije tekst van het kind', () => {
  // Dat is niet gierig maar precies de reden dat hij langs de messages-poort
  // mag: anders is dit een kanaal om omheen die poort te praten.
  const note = gatereq.requestNote({ id: 'x', me: 'https://k/u/kind', feature: 'shaer:music', to: ['https://oma.test/ap/users/oma'] });
  assert.equal(note['shaer:gateRequest'], 'shaer:music');
  assert.equal(note.content, '<p>Mag dit aan?</p>');
});

test('een verzoek is NIET de reddingsboei', () => {
  // Ze door elkaar laten lopen devalueert de boei. Een verzoek draagt geen
  // helpRequest-vlag, en een hulpvraag geen feature.
  const note = gatereq.requestNote({ id: 'x', me: 'https://k/u/kind', feature: 'shaer:music', to: [] });
  assert.equal(note['shaer:helpRequest'], undefined);
  assert.equal(gatereq.parseRequest({ 'shaer:helpRequest': true }), null);
});
