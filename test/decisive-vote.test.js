// Weet je dat je de doorslag geeft? (shaer-8vt)
//
// De telling is een race naar de drempel: zodra het aantal gehaald is, is het
// besluit gevallen. Bij 2 van 3 is de tweede ja meteen de beslissing, en sinds
// Barts meerderheidsbesluit is bij een volgverzoek met twee guardians de EERSTE
// ja dat al. Wie antwoordde wist dat niet, en het scherm zei het nergens.
//
// Wat hier bewaakt wordt is vooral de FAALSTAND: bij twijfel waarschuwen. De
// twee fouten zijn niet gelijk -- zeggen dat je beslist terwijl dat niet zo is
// maakt iemand voorzichtiger dan nodig; niets zeggen terwijl hij wel beslist
// laat hem het onwetend doen.
//
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const gated = await import('../src/services/guardianship/gated.js');
const follows = await import('../src/services/guardianship/follows.js');

test('de laatste stem die nodig is, is beslissend', () => {
  assert.equal(gated.isDecisive(1, 2), true);    // nog een nodig: die van jou
  assert.equal(gated.isDecisive(2, 3), true);
});

test('met nog twee te gaan ben je het niet', () => {
  assert.equal(gated.isDecisive(0, 2), false);
  assert.equal(gated.isDecisive(1, 3), false);
});

test('een drempel van 1 maakt de EERSTE stem beslissend', () => {
  // Dit is het geval dat Barts meerderheidsbesluit oplevert: twee guardians,
  // drempel 1. Wie als eerste ja zegt heeft het besloten.
  assert.equal(gated.isDecisive(0, 1), true);
  assert.equal(gated.isDecisive(0, follows.followThreshold(2)), true);
});

test('bij drie guardians is de eerste ja NIET beslissend', () => {
  assert.equal(gated.isDecisive(0, follows.followThreshold(3)), false);
});

test('onzin telt als BESLISSEND, niet als veilig', () => {
  // Een ontbrekend of onleesbaar getal mag nooit "je beslist niets" opleveren.
  // Dat is de stille fout: het scherm zwijgt precies wanneer het moet spreken.
  assert.equal(gated.isDecisive(undefined, undefined), true);
  assert.equal(gated.isDecisive(NaN, NaN), true);
  assert.equal(gated.isDecisive(null, null), true);
});
