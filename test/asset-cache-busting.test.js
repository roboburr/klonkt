// Geen asset-URL zonder cache-buster (shaer-724).
//
// /assets wordt buiten ontwikkeling een JAAR gecachet. Een pad zonder `?v=`
// blijft dus een jaar staan bij iedereen die het ooit ophaalde, en dan draait
// een terugkerende bezoeker oude code tegen nieuwe templates -- onreproduceerbaar
// per bezoeker, want het hangt af van wanneer hij hier voor het laatst was.
//
// De bootstrap hangt ?v= aan de modules die hij ZELF laadt. Twee soorten paden
// ontsnappen daaraan, en allebei zijn ze een keer misgegaan:
//
//   een import BINNEN een module is relatief, en een relatieve specifier erft
//   de query niet: `./lib.js` naast `post.js?v=63` wordt `/assets/js/mod/lib.js`.
//   Daar is de importmap in de shell voor.
//
//   een vendorbestand dat een module zelf ophaalt (import, script- of
//   link-element). Die hoort ?v=${VENDOR_V} te dragen.
//
// Deze toets leest de bron, en dat is hier op zijn plaats: het gaat om de vorm
// van een URL in de code, niet om gedrag dat je kunt aanroepen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORTEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD_DIR = path.join(WORTEL, 'src', 'assets', 'js', 'mod');
const SHELL = fs.readFileSync(path.join(WORTEL, 'src', 'views', 'shell.ejs'), 'utf8');

const modules = fs.readdirSync(MOD_DIR).filter((n) => n.endsWith('.js'));
const bron = (naam) => fs.readFileSync(path.join(MOD_DIR, naam), 'utf8');

test('elke relatieve import tussen modules staat in de importmap', () => {
  // De importmap is de enige plek waar zo\'n pad zijn versie kan krijgen, want
  // de import zelf kan hem niet meedragen.
  const ontbreekt = [];
  for (const naam of modules) {
    for (const m of bron(naam).matchAll(/from\s+'(\.\.?\/[^']+)'/g)) {
      const doel = path.posix.normalize(path.posix.join('/assets/js/mod', m[1]));
      if (!SHELL.includes(`"${doel}":`)) ontbreekt.push(`${naam} -> ${doel}`);
    }
  }
  assert.deepEqual(ontbreekt, [],
    'zonder ingang in de importmap wordt dit pad kaal opgehaald en een jaar bewaard');
});

test('elk vendorbestand dat een module ophaalt draagt een versie', () => {
  const kaal = [];
  for (const naam of modules) {
    for (const m of bron(naam).matchAll(/['"`]\/assets\/vendor\/[^'"`]+['"`]/g)) {
      if (!m[0].includes('?v=')) kaal.push(`${naam}: ${m[0]}`);
    }
  }
  assert.deepEqual(kaal, [], 'voeg ?v=${VENDOR_V} toe, anders blijft de oude bibliotheek een jaar staan');
});

test('de importmap en de bootstrap delen een nummer', () => {
  // Twee losse nummers lopen een keer uit elkaar, en dan verspringt de ene
  // helft van de modules wel en de andere niet.
  const uitEjs = SHELL.match(/const MOD_V = (\d+);/);
  assert.ok(uitEjs, 'MOD_V hoort als EJS-variabele bovenaan de shell te staan');
  assert.match(SHELL, /var MOD_V = <%= MOD_V %>;/, 'de bootstrap hoort dat nummer te gebruiken, niet een eigen kopie');
  assert.match(SHELL, /\?v=<%= MOD_V %>/, 'en de importmap ook');
});
