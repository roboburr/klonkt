/**
 * Convert a freshly uploaded image to WebP (smaller, modern format).
 *
 * Uses the system `cwebp` (libwebp). Present → convert + delete the original,
 * return the new .webp filename. Not present or error → return the original
 * filename (graceful fallback, nothing breaks).
 *
 * GIF stays GIF (cwebp cannot produce animated WebP from a GIF); already-WebP
 * files are skipped.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const QUALITY = '82';

/**
 * @param {{path:string, filename:string, destination?:string}} file  multer file
 * @returns {string} the final filename (basename) — .webp or the original
 */
export function toWebp(file) {
  if (!file || !file.path || !file.filename) return file && file.filename;
  const ext = path.extname(file.filename).toLowerCase();
  if (ext === '.webp' || ext === '.gif') return file.filename;
  const dir = file.destination || path.dirname(file.path);
  const outName = path.basename(file.filename, ext) + '.webp';
  const outPath = path.join(dir, outName);
  try {
    execFileSync('cwebp', ['-quiet', '-q', QUALITY, file.path, '-o', outPath], { stdio: 'ignore' });
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('empty output');
    try { fs.unlinkSync(file.path); } catch { /* original gone, not critical */ }
    return outName;
  } catch (e) {
    console.warn('[webp] conversion skipped (cwebp not available/error):', e.message);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {} // clean up partial output
    return file.filename; // keep original
  }
}

export default { toWebp };
