#!/usr/bin/env node
//
// Importeer een inhoudsarchief in een site (shaer-pmr).
//
//     node scripts/import-archive.mjs <slug> <archief.zip|map> --dry-run
//     node scripts/import-archive.mjs <slug> <archief.zip|map>
//     node scripts/import-archive.mjs <slug> <archief.zip|map> --overwrite
//
// Het formaat staat in docs/EXPORT-FORMAT.md.
//
// Standaard wordt een bestaande post met hetzelfde id of dezelfde slug
// OVERGESLAGEN. Dat maakt de import idempotent en zorgt dat je nooit per ongeluk
// inhoud vernietigt die er al staat. --overwrite doet het wel, expliciet.
//
// Er gaat GEEN Update de fediverse in. Als andere servers een oudere kopie
// hebben, blijft die daar staan; dat rechttrekken is een uitzending naar iedereen
// en hoort een aparte, bewuste actie te zijn.

import { readArchive, importArchive } from '../src/services/ArchiveImportService.js';

const args = process.argv.slice(2);
const vrij = args.filter((a) => !a.startsWith('-'));
const [slug, bron] = vrij;

if (!slug || !bron) {
  console.error('gebruik: node scripts/import-archive.mjs <slug> <archief.zip|map> [--dry-run] [--overwrite]');
  process.exit(1);
}

let files;
try { files = readArchive(bron); }
catch (e) { console.error(`kan het archief niet lezen: ${e.message}`); process.exit(1); }

let r;
try { r = importArchive(files, { slug, dryRun: args.includes('--dry-run'), overwrite: args.includes('--overwrite') }); }
catch (e) { console.error(`geweigerd: ${e.message}`); process.exit(1); }

console.log(`formaatversie : ${r.formatVersion}`);
console.log(`herkomst      : ${r.origin || '(geen)'}`);
console.log(`AP-ids        : ${r.idsBehouden ? 'BEHOUDEN (zelfde origin)' : 'nieuw (andere origin)'}`);
console.log(`posts         : ${r.posts}${r.overschreven ? `, waarvan ${r.overschreven} overschreven` : ''}`);
console.log(`overgeslagen  : ${r.overgeslagen}   (bestonden al)`);
console.log(`antwoorden    : ${r.replies}   (alleen-lezen archief)`);
console.log(`media         : ${r.media} teruggezet, ${r.mediaMissing} ontbrekend`);

if (r.gemist.length) {
  console.log('\nontbrekende media:');
  for (const m of r.gemist.slice(0, 20)) console.log(`  ${m.post}  ${m.url}`);
  if (r.gemist.length > 20) console.log(`  ... en nog ${r.gemist.length - 20}`);
}
for (const w of r.waarschuwingen) console.log(`\nLET OP: ${w}`);

if (args.includes('--dry-run')) console.log('\n--dry-run: niets geschreven.');
