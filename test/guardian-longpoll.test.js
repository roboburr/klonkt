// De wekker onder het Guardian-paneel (Barts opdracht, 9-8).
//
// Het paneel tikte elke 45 seconden, ongeacht of er iets gebeurd was. Nu hangt
// er een verzoek open tot er iets is dat de guardian moet verwerken.
//
// Wat hier bewaakt wordt is de BUS, niet de route: dat elke soort gebeurtenis
// wekt, dat een wachter maar EEN keer gewekt wordt, en dat een wachter die zich
// afmeldt ook echt weg is. Een lange poll die niet wekt is niet te onderscheiden
// van een trage server -- en dat is precies het soort fout dat niemand meldt.
//
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
const AP = await import('../src/services/ActivityPubService.js');

test('een wachter wordt gewekt', () => {
  let gewekt = 0;
  AP.onGuardian('kind', () => { gewekt += 1; });
  AP.wakeGuardian('kind');
  assert.equal(gewekt, 1);
});

test('en daarna vergeten: een tweede wek doet niets', () => {
  // Het antwoord dat volgt is de nieuwe waarheid; de client komt terug met een
  // nieuwe wachter. Bleef hij staan, dan zou een burst van tien gebeurtenissen
  // tien antwoorden op hetzelfde verzoek proberen te schrijven.
  let gewekt = 0;
  AP.onGuardian('kind2', () => { gewekt += 1; });
  AP.wakeGuardian('kind2');
  AP.wakeGuardian('kind2');
  assert.equal(gewekt, 1);
});

test('afmelden werkt', () => {
  // Hangt de client op, dan moet de wachter weg. Anders lekt elke afgebroken
  // verbinding een callback, en bij een lange poll is dat elke 25 seconden een.
  let gewekt = 0;
  const af = AP.onGuardian('kind3', () => { gewekt += 1; });
  af();
  AP.wakeGuardian('kind3');
  assert.equal(gewekt, 0);
});

test('wekken raakt alleen de eigen guardian', () => {
  let a = 0; let b = 0;
  AP.onGuardian('oma', () => { a += 1; });
  AP.onGuardian('opa', () => { b += 1; });
  AP.wakeGuardian('oma');
  assert.equal(a, 1);
  assert.equal(b, 0);
});

test('meerdere schermen van dezelfde guardian worden allemaal gewekt', () => {
  // Telefoon en laptop naast elkaar. Zou alleen de laatste wachter gewekt
  // worden, dan blijft het andere scherm stil staan.
  let n = 0;
  AP.onGuardian('duo', () => { n += 1; });
  AP.onGuardian('duo', () => { n += 1; });
  AP.wakeGuardian('duo');
  assert.equal(n, 2);
});

test('een wachter die stukgaat breekt de rest niet', () => {
  // Een kapotte callback mag nooit de andere schermen laten hangen.
  let goed = 0;
  AP.onGuardian('stuk', () => { throw new Error('boem'); });
  AP.onGuardian('stuk', () => { goed += 1; });
  AP.wakeGuardian('stuk');
  assert.equal(goed, 1);
});

test('wekken zonder wachters is geen fout', () => {
  assert.doesNotThrow(() => AP.wakeGuardian('niemand'));
});

test('ELKE guardianship-gebeurtenis wekt, ook die geen melding waard is', () => {
  // De kern van Barts opdracht: push kiest bewust een handvol soorten, het
  // scherm hoort ze allemaal te weten. Dit gaat door de ECHTE handler heen --
  // een eerdere versie toetste alleen de bus, en toen bleef de mutatie die het
  // wekken uit onEvent haalde gewoon groen.
  const ev = { kind: 'lapse_vote', lapse: 'x', by: 'y', state: 'recorded' };
  assert.equal(AP.guardianEventPush('kind9', ev), null, 'deze soort geeft geen melding');

  let gewekt = 0;
  AP.onGuardian('kind9', () => { gewekt += 1; });
  AP.onGuardianshipEvent('kind9', ev);
  assert.equal(gewekt, 1, 'en toch wordt het paneel gewekt');
});

test('een gebeurtenis die WEL een melding is, wekt ook', () => {
  let gewekt = 0;
  AP.onGuardian('kind10', () => { gewekt += 1; });
  AP.onGuardianshipEvent('kind10', { kind: 'committed', ward: 'https://w/x' });
  assert.equal(gewekt, 1);
});
