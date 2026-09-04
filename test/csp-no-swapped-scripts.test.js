// Geen uitvoerbaar script in inhoud die htmx wisselt (shaer-0i6).
//
// De CSP-nonce rouleert per verzoek. Een pagina die je via een link BINNEN de
// site opent komt als fragment binnen, met de nonce van dat verzoek -- en die
// kent het al geladen document niet, dus wordt zo'n script geweigerd. Elk
// paginascript hoort daarom uit de shell te komen, die op body[data-js] een
// module importeert; de gegevens gaan via partials/page-data.ejs.
//
// De valkuil die dit bewaakt: de fout is ONZICHTBAAR na een herlading. Wie een
// script terugzet in een view merkt daar bij het testen niets van, tenzij hij
// er via de navigatie naartoe gaat. Deze toets merkt het wel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIEWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');

// Losse DOCUMENTEN, geen fragmenten: deze gaan via res.render en niet via
// renderPage, dus htmx wisselt ze nooit in en hun scripts komen altijd met de
// nonce van hun eigen laadbeurt binnen. Wie hier iets aan toevoegt moet dus
// eerst nagaan langs welke weg de pagina gerenderd wordt.
const LOSSE_DOCUMENTEN = new Set(['pages/embed-player.ejs', 'pages/guardian.ejs']);

function views() {
  const uit = [];
  for (const map of ['pages', 'partials']) {
    for (const naam of fs.readdirSync(path.join(VIEWS, map))) {
      if (naam.endsWith('.ejs')) uit.push(`${map}/${naam}`);
    }
  }
  return uit.sort();
}

test('geen uitvoerbaar script in een view die als fragment binnenkomt', () => {
  const overtreders = [];
  for (const rel of views()) {
    if (LOSSE_DOCUMENTEN.has(rel)) continue;
    // EJS-commentaar eerst weg: dat komt nooit in de uitvoer, en de views
    // leggen juist in zo'n commentaar uit welke scripttag daar wegging. Zonder
    // dit sloeg deze toets aan op zijn eigen uitleg.
    const bron = fs.readFileSync(path.join(VIEWS, rel), 'utf8').replace(/<%#[\s\S]*?%>/g, '');
    for (const m of bron.matchAll(/<script\b[^>]*>/gi)) {
      // Een datablok (application/json) wordt door de browser nooit
      // uitgevoerd, dus daar gaat script-src niet over. Dat is de vorm
      // waarin een pagina zijn gegevens wel mag meegeven.
      if (/type\s*=\s*["']application\/json["']/i.test(m[0])) continue;
      overtreders.push(`${rel}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(overtreders, [],
    'deze scripts overleven een htmx-navigatie niet; laat de shell de module laden (zie shaer-0i6)');
});

test('de losse documenten bestaan nog, anders bewaakt de uitzondering niets', () => {
  // Een uitzonderingslijst die naar verdwenen bestanden wijst maakt de toets
  // stilletjes zwakker: hernoemt iemand zo'n pagina, dan valt hij ineens onder
  // de regel zonder dat iemand dat besloot.
  for (const rel of LOSSE_DOCUMENTEN) {
    assert.ok(fs.existsSync(path.join(VIEWS, rel)), `${rel} staat op de uitzonderingslijst maar bestaat niet meer`);
  }
});
