#!/usr/bin/env node
//
// Herstel de posts van een verloren Klonkt uit de tijdlijn-cache van instances
// die haar volgden (shaer-l1v).
//
//     node scripts/recover-from-cache.mjs \
//       --actor https://boiert.eu/ap/users/boiert \
//       --from /pad/naar/sound-fabrics/database.sqlite \
//       --from /pad/naar/nog-een/database.sqlite \
//       --media /geredde/storage/media \
//       --audio /geredde/storage/audio \
//       --out boiert-herstel.zip
//
// Het resultaat is een gewoon archief in het formaat uit docs/EXPORT-FORMAT.md.
// Terugzetten gaat dus met scripts/import-archive.mjs, met dezelfde droogloop en
// dezelfde regel rond het behouden van AP-ids. Er is bewust geen apart
// herstelpad: dat zou een tweede implementatie zijn van iets dat al bestaat.
//
// WAT HIER PRINCIPIEEL NIET IN ZIT:
//   - antwoorden van de verloren site zelf (die staan niet in een tijdlijn-cache)
//   - alles van voor het moment dat de bron ging volgen
//   - concepten (nooit gefedereerd, dus nergens gecachet)
//   - de plek van afbeeldingen IN de tekst (bij het federeren eruit gehaald)

import fs from 'fs';
import path from 'path';
import { recoverFromCache } from '../src/services/ArchiveRecoveryService.js';
import { zipArchive } from '../src/services/ArchiveExportService.js';

const args = process.argv.slice(2);
const alle = (naam) => args.reduce((uit, a, i) => (a === naam && args[i + 1] ? [...uit, args[i + 1]] : uit), []);
const een = (naam) => alle(naam)[0] || null;

const actor = een('--actor');
const sources = alle('--from');
if (!actor || !sources.length) {
  console.error('gebruik: node scripts/recover-from-cache.mjs --actor <actor-uri> --from <db> [--from <db>] [--media <map>] [--audio <map>] [--out <zip> | --dir <map>] [--houd-titel]');
  process.exit(1);
}

let uit;
try {
  uit = recoverFromCache({
    sources, actorUri: actor, mediaRoot: een('--media'), audioRoot: een('--audio'),
    houdTitelInTekst: args.includes('--houd-titel'),
    slug: een('--slug') || '', title: een('--titel') || '',
  });
} catch (e) { console.error(`kan niet herstellen: ${e.message}`); process.exit(1); }

const r = uit.rapport;
console.log('bronnen:');
for (const b of r.bronnen) console.log(`  ${b.rijen.toString().padStart(5)} rij(en)  ${b.pad}`);
console.log(`\nposts gevonden : ${r.posts}`);
console.log(`periode        : ${r.oudste || '?'}  tot  ${r.nieuwste || '?'}`);
console.log(`media          : ${r.media} gered, ${r.mediaMissing} niet gevonden`);
console.log(`titels          : ${r.titels.length} losgetrokken uit de tekst`);

// De titels horen door een MENS nagelopen te worden. Er is geen sluitend signaal
// dat een vetgedrukte eerste regel een titel was; de slug is er niet van afgeleid.
if (r.titels.length) {
  console.log('\nteruggevonden titels -- loop deze na, een post die echt met een vetgedrukte');
  console.log('regel begint raakt die regel kwijt aan zijn titel:');
  for (const t of r.titels.slice(0, 30)) console.log(`  ${t.slug.padEnd(28)} ${t.titel}`);
  if (r.titels.length > 30) console.log(`  ... en nog ${r.titels.length - 30}`);
}
if (r.gemist.length) {
  console.log('\nmedia niet gevonden op schijf:');
  for (const m of r.gemist.slice(0, 20)) console.log(`  ${m.slug.padEnd(28)} ${m.url}`);
  if (r.gemist.length > 20) console.log(`  ... en nog ${r.gemist.length - 20}`);
}
for (const w of r.waarschuwingen) console.log(`\nLET OP: ${w}`);

console.log('\nNIET herstelbaar uit een tijdlijn-cache: eigen antwoorden, alles van voor het');
console.log('volgmoment, concepten, en de plek van afbeeldingen in de tekst.');

if (args.includes('--dry-run')) {
  console.log(`\n--dry-run: ${uit.files.size} bestand(en) zouden geschreven worden. Niets geschreven.`);
  process.exit(0);
}

const dir = een('--dir');
if (dir) {
  for (const pad of [...uit.files.keys()].sort()) {
    const doel = path.join(dir, pad);
    fs.mkdirSync(path.dirname(doel), { recursive: true });
    fs.writeFileSync(doel, uit.files.get(pad));
  }
  console.log(`\ngeschreven naar ${path.resolve(dir)}`);
  process.exit(0);
}

const out = een('--out') || 'herstel.zip';
fs.writeFileSync(out, zipArchive(uit.files));
console.log(`\ngeschreven: ${out} (${fs.statSync(out).size} bytes)`);
console.log(`\nterugzetten:  node scripts/import-archive.mjs <slug> ${out} --dry-run`);
