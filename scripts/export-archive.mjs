#!/usr/bin/env node
//
// Exporteer het inhoudsarchief van een site (shaer-1a6).
//
//     node scripts/export-archive.mjs <slug> --dry-run
//     node scripts/export-archive.mjs <slug> --out boiert.zip
//     node scripts/export-archive.mjs <slug> --dir ./archief
//
// Op een machine met meerdere instances leest hij de .env van die instance zelf
// (standaard /var/lib/klonkt/<slug>/.env). Dat is niet netjesheid maar noodzaak:
// zonder die .env opent hij de database die toevallig in de code-map ligt, en op
// een server die ooit de enkelvoudige opzet draaide is dat een oude lege. Dan
// komt er een archief uit dat MELDT dat het gelukt is en nul posts bevat.
//
//     --data-root <map>   waar de instances staan (standaard /var/lib/klonkt)
//     --env <pad>         een .env rechtstreeks aanwijzen
//
// Het formaat staat in docs/EXPORT-FORMAT.md.
//
// Dit is NIET de storage-zip: er zit geen sleutel, sessie, wachtwoordhash of
// DM van een ander in. Wel je eigen concepten, en -- als je die hebt -- de
// volledige inhoud van betaalde posts. Behandel het bestand als de inhoud zelf.

import fs from 'fs';
import path from 'path';
import { kiesInstance, eisOrigin } from './instance-env.mjs';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('-'));
const vlag = (naam) => { const i = args.indexOf(naam); return i >= 0 ? (args[i + 1] || true) : null; };

if (!slug) {
  console.error('gebruik: node scripts/export-archive.mjs <slug> [--data-root <map>] [--env <pad>] [--dry-run | --out <zip> | --dir <map>]');
  process.exit(1);
}

// EERST de instance kiezen, DAN pas de service laden: src/config/database.js
// leest DATABASE_PATH bij import en opent de database meteen.
let gekozen;
try {
  gekozen = kiesInstance(slug, {
    dataRoot: typeof vlag('--data-root') === 'string' ? vlag('--data-root') : null,
    envPad: typeof vlag('--env') === 'string' ? vlag('--env') : null,
  });
} catch (e) { console.error(e.message); process.exit(1); }
eisOrigin(gekozen.bron);

const { buildArchive, zipArchive, writeArchiveDir } = await import('../src/services/ArchiveExportService.js');

let uit;
try { uit = buildArchive(slug); }
catch (e) {
  console.error(`${e.message}`);
  if (gekozen.bron) console.error(`(gelezen uit ${gekozen.bron})`);
  else console.error('(geen instance-.env gevonden -- op een split install: --data-root /var/lib/klonkt)');
  process.exit(1);
}
const t = uit.counts;
console.log(`site      : ${uit.manifest.site.slug} (${uit.manifest.origin})`);
console.log(`instellingen uit: ${gekozen.bron || 'de omgeving'}`);
console.log(`database  : ${process.env.DATABASE_PATH || '(standaard in de code-map)'}`);
console.log(`posts     : ${t.posts}`);
console.log(`antwoorden: ${t.replies}   (alleen-lezen archief)`);
console.log(`media     : ${t.media} meegenomen, ${t.mediaMissing} ontbrekend`);

// Ontbrekende media worden GETELD en GEMELD, nooit stil overgeslagen: een post
// waarvan het plaatje verdwenen is hoort dat te zeggen.
if (uit.missing.length) {
  console.log('\nontbrekende media:');
  for (const m of uit.missing.slice(0, 20)) console.log(`  ${m.post}  ${m.url}`);
  if (uit.missing.length > 20) console.log(`  ... en nog ${uit.missing.length - 20}`);
}

if (args.includes('--dry-run')) {
  console.log(`\n--dry-run: ${uit.files.size} bestand(en) zouden geschreven worden. Niets geschreven.`);
  process.exit(0);
}

const dir = vlag('--dir');
if (dir && typeof dir === 'string') {
  writeArchiveDir(uit.files, dir);
  console.log(`\ngeschreven naar ${path.resolve(dir)}`);
  process.exit(0);
}

const out = (typeof vlag('--out') === 'string' ? vlag('--out') : null) || `${slug}-archief.zip`;
fs.writeFileSync(out, zipArchive(uit.files));
console.log(`\ngeschreven: ${out} (${fs.statSync(out).size} bytes)`);
