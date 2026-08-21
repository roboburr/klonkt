// De playlist-modal spreekt de taal van de pagina (16-8).
//
// Tot vandaag stonden de teksten hard in mod/playlist-editor.js. Dat viel niet
// op omdat het toevallig de brontaal was: een Engelse of Duitse beheerder kreeg
// een Nederlandse modal midden in een verder vertaalde pagina, en er is geen
// foutmelding die dat meldt.
//
// Deze test sluit de KETEN, en dat is het punt -- er zijn drie schakels en elke
// schakel kan los kloppen terwijl het geheel stuk is:
//
//   het script vraagt T('x')  ->  de partial zet 'x' in het gegevensblok
//                             ->  i18n.js kent 'ple.x' in nl, en EN de
//
// Een nieuwe tekst toevoegen en een van de drie vergeten is de fout die dit
// vangt, en juist de vergeten TAAL merkt niemand die in het Nederlands werkt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync('src/assets/js/mod/playlist-editor.js', 'utf8');
const partial = fs.readFileSync('src/views/partials/playlist-editor.ejs', 'utf8');
const i18n = fs.readFileSync('src/services/i18n.js', 'utf8');

// Alle sleutels die het script opvraagt. De declaratie van T() zelf niet.
const gevraagd = new Set(
  [...script.matchAll(/\bT\('([a-z0-9_]+)'\)/g)].map((m) => m[1])
);

test('het script vraagt uberhaupt sleutels op', () => {
  assert.ok(gevraagd.size > 20, `maar ${gevraagd.size} sleutels gevonden -- klopt het patroon nog?`);
});

test('elke gevraagde sleutel staat in het gegevensblok van de partial', () => {
  const blok = /data-playlist-editor-i18n><%-([\s\S]*?)%><\/script>/.exec(partial);
  assert.ok(blok, 'geen i18n-blok in de partial');
  const ontbreekt = [...gevraagd].filter((k) => !new RegExp(`\\b${k}:\\s*t\\('ple\\.${k}'\\)`).test(blok[1]));
  assert.deepEqual(ontbreekt, [], `niet doorgegeven vanuit de partial: ${ontbreekt.join(', ')}`);
});

test('elke sleutel bestaat in alle drie de talen', () => {
  // De taalblokken staan achter elkaar in i18n.js; per sleutel tellen hoe vaak
  // hij voorkomt is genoeg om een vergeten vertaling te vinden.
  const tekort = [];
  for (const k of gevraagd) {
    const n = (i18n.match(new RegExp(`'ple\\.${k}':`, 'g')) || []).length;
    if (n !== 3) tekort.push(`${k} (${n}x)`);
  }
  assert.deepEqual(tekort, [], `niet in alle drie de talen: ${tekort.join(', ')}`);
});

test('er staat geen losse Nederlandse knoptekst meer in het script', () => {
  // Grof maar effectief: dit zijn de woorden die er tot vandaag in stonden.
  // Komt er een terug, dan is iemand de T() vergeten.
  const verdacht = ['Annuleren', 'Opslaan', 'Aanmaken', 'Sluiten', 'Verslepen', 'Verwijderen',
                    'Beschikbare tracks', 'Geen resultaten', 'Uitgavedatum', 'Jaar', 'Artiest'];
  // COMMENTAAR ERAF. De eerste versie sloeg alarm op een regel die alleen
  // uitlegde wat er gebeurt -- en een test die op uitleg valt leert je hem
  // negeren.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const gevonden = verdacht.filter((w) => new RegExp(`['"\`>]${w}`).test(code));
  assert.deepEqual(gevonden, [], `hardgecodeerde tekst terug in het script: ${gevonden.join(', ')}`);
});

test('het eigen gegevensblok botst niet met dat van de pagina', () => {
  // pageData() pakt met querySelector EEN blok. Zou deze partial het gewone
  // data-page-data gebruiken, dan won het blok van de gastpagina en bleef de
  // modal onvertaald -- zonder dat er iets omvalt.
  assert.ok(partial.includes('data-playlist-editor-i18n'), 'eigen kenmerk weg');
  assert.ok(!/data-page-data/.test(partial), 'de partial gebruikt het gedeelde blok');
  assert.ok(script.includes('data-playlist-editor-i18n'), 'het script leest het eigen blok niet');
});
