// Twee lijsten die hetzelfde horen te weten, en niets dat ze bij elkaar houdt.
//
// GATE_CATALOGUE zegt WAT er gated is. Het shaer:capabilities-blok zegt wat een
// account op dit moment MAG. Ze worden allebei met de hand bijgehouden, op twee
// plekken, en er komt geen fout van als er eentje achterblijft: de gate
// verschijnt netjes in het paneel van de guardian, en de app van het kind hoort
// er nooit van. Die stilte is het probleem -- de app ontdekt de poort dan pas
// bij de eerste weigering, wat precies is wat het commentaar bij dat blok zegt
// te willen voorkomen ("de app hoort VOORAF te weten wat hij mag aanbieden").
//
// Zo'n gat is echt gevallen: shaer:accountMove stond in de catalogus met een
// kolom en al, en ontbrak in capabilities. Deze test is de reden dat het de
// volgende keer opvalt zonder dat iemand het toevallig ziet.
//
// Eén richting, met opzet. Niet elke capability is een gate: shaer:externalLinks
// hangt aan de playback-poort en shaer:cursor is helemaal geen poort maar een
// leesteken voor de wachtrij.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const gated = await import('../src/services/guardianship/gated.js');

const SOURCE = 'src/routes/activitypub.js';

/** De sleutels van het rechtenblok, gelezen uit de bron.
 *
 *  Het blok woont sinds 10-8 in capabilitiesOf(), omdat de verschil-lezing
 *  (?changes=1) dezelfde rechten moet dragen: een antwoord zonder rechten laat
 *  de client terugvallen op zijn standaard, en die standaard is 'alles mag'.
 *  Deze toets kijkt daarom naar die functie en niet meer naar de plek in de
 *  route. */
function capabilityKeys() {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const start = src.indexOf('function capabilitiesOf(');
  assert.notEqual(start, -1, `${SOURCE} heeft geen capabilitiesOf() meer`);
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = src.slice(open + 1, end);
  return new Set([...body.matchAll(/'(shaer:[a-zA-Z]+)'\s*:/g)].map((m) => m[1]));
}

test('elke gate met een eigen kolom staat ook in shaer:capabilities', () => {
  const caps = capabilityKeys();
  assert.ok(caps.size > 5, 'het blok is gevonden en niet leeg');

  // Een kolom hebben is het criterium: dat is precies de verzameling poorten
  // waar een stand van bewaard wordt, en dus waar de app iets aan heeft. Een
  // vaste poort (shaer:follows) heeft er geen, want er valt niets te bewaren,
  // en een geplande (available: false) bestaat nog niet.
  const missing = gated.GATE_CATALOGUE
    .filter((g) => g.available !== false && gated.featureColumn(g.feature))
    .map((g) => g.feature)
    .filter((f) => !caps.has(f));

  assert.deepEqual(missing, [],
    `deze poorten bestaan wel maar de app krijgt ze niet te horen: ${missing.join(', ')}`);
});

test('een vaste of geplande poort hoeft er niet in te staan', () => {
  // De regel hierboven mag niet zo streng worden dat hij dingen eist die geen
  // stand hebben. shaer:follows ligt vast (§5.3) en shaer:publicProfile bestaat
  // nog niet; allebei terecht afwezig, en dat moet zo kunnen blijven.
  const caps = capabilityKeys();
  assert.equal(caps.has('shaer:follows'), false, 'vast: geen kolom, geen capability');
  assert.equal(gated.featureColumn('shaer:publicProfile'), null, 'gepland: nog geen kolom');
});
