#!/usr/bin/env node
/**
 * Backfill audio_tracks.duration for existing tracks that have no duration yet.
 * Reads the duration from the mp3 file via ffmpeg (probeDuration — no separate
 * ffprobe binary required). Idempotent: only touches rows with duration NULL or 0,
 * so it is safe to run repeatedly.
 *
 *   npm run backfill:durations
 *
 * Respects AUDIO_PATH (env) just like the upload route.
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

// storage_path is absolute (stored at upload time); fall back to AUDIO_DIR/filename.
function resolveFile(t) {
  const candidates = [t.storage_path, t.filename ? path.join(AUDIO_DIR, t.filename) : null].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* try next candidate */ }
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
