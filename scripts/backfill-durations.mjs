#!/usr/bin/env node
/**
 * Backfill audio_tracks.duration voor bestaande tracks die nog géén duur hebben.
 * Leest de duur uit het mp3-bestand via ffmpeg (probeDuration — geen aparte
 * ffprobe-binary nodig). Idempotent: pakt alleen rijen met duration NULL of 0,
 * dus veilig herhaalbaar.
 *
 *   npm run backfill:durations
 *
 * Respecteert AUDIO_PATH (env) net als de upload-route.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../src/config/database.js';
import { probeDuration } from '../src/services/AudioTranscoder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.resolve(
  process.env.AUDIO_PATH || path.join(__dirname, '..', 'storage', 'audio')
);

// storage_path is absoluut (opgeslagen bij upload); val terug op AUDIO_DIR/filename.
function resolveFile(t) {
  const candidates = [t.storage_path, t.filename ? path.join(AUDIO_DIR, t.filename) : null].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* volgende kandidaat */ }
  }
  return null;
}

const rows = db.prepare(`
  SELECT t.id, m.filename, m.storage_path
  FROM audio_tracks t
  JOIN media m ON m.id = t.media_id
  WHERE (t.duration IS NULL OR t.duration = 0) AND m.filename IS NOT NULL
`).all();

console.log(`[backfill-durations] ${rows.length} track(s) zonder duur`);
const update = db.prepare('UPDATE audio_tracks SET duration = ? WHERE id = ?');

let ok = 0, miss = 0, fail = 0;
for (const t of rows) {
  const file = resolveFile(t);
  if (!file) { console.warn(`  - ${t.id}: bestand niet gevonden (${t.filename})`); miss++; continue; }
  try {
    const sec = await probeDuration(file);
    if (sec && sec > 0) { update.run(sec, t.id); ok++; console.log(`  ✓ ${t.id}: ${sec}s`); }
    else { console.warn(`  - ${t.id}: geen duur uit ffmpeg`); fail++; }
  } catch (e) { console.warn(`  - ${t.id}: ${e.message}`); fail++; }
}
console.log(`[backfill-durations] klaar — ${ok} bijgewerkt, ${miss} bestand-mist, ${fail} mislukt`);
process.exit(0);
