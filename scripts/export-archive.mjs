#!/usr/bin/env node
//
// Exporteer het inhoudsarchief van een site (shaer-1a6).
//
//     node scripts/export-archive.mjs <slug> --dry-run
//     node scripts/export-archive.mjs <slug> --out boiert.zip
//     node scripts/export-archive.mjs <slug> --dir ./archief
//
// Het formaat staat in docs/EXPORT-FORMAT.md.
//
// Dit is NIET de storage-zip: er zit geen sleutel, sessie, wachtwoordhash of
// DM van een ander in. Wel je eigen concepten, en -- als je die hebt -- de
// volledige inhoud van betaalde posts. Behandel het bestand als de inhoud zelf.

import fs from 'fs';
import path from 'path';
import { buildArchive, zipArchive, writeArchiveDir } from '../src/services/ArchiveExportService.js';

const args = process.argv.slice(2);
const slug = args.find((a) => !a.startsWith('-'));
const vlag = (naam) => { const i = args.indexOf(naam); return i >= 0 ? (args[i + 1] || true) : null; };

if (!slug) {
  console.error('gebruik: node scripts/export-archive.mjs <slug> [--dry-run | --out <zip> | --dir <map>]');
  process.exit(1);
}

const uit = buildArchive(slug);
const t = uit.counts;
console.log(`site      : ${uit.manifest.site.slug} (${uit.manifest.origin || 'geen PUBLIC_BASE_URL'})`);
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
