/**
 * Zet een zojuist-geüploade afbeelding om naar WebP (kleiner, modern).
 *
 * Gebruikt het systeem-`cwebp` (libwebp). Aanwezig → converteer + verwijder het
 * origineel, geef de nieuwe .webp-bestandsnaam terug. Niet aanwezig of fout →
 * geef de originele bestandsnaam terug (graceful fallback, niks breekt).
 *
 * GIF blijft GIF (cwebp maakt geen geanimeerde webp van een gif); reeds-webp
 * wordt overgeslagen.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const QUALITY = '82';

/**
 * @param {{path:string, filename:string, destination?:string}} file  multer file
 * @returns {string} de definitieve bestandsnaam (basename) — .webp of het origineel
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
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) throw new Error('lege output');
    try { fs.unlinkSync(file.path); } catch { /* origineel weg, niet kritisch */ }
    return outName;
  } catch (e) {
    console.warn('[webp] conversie overgeslagen (cwebp niet beschikbaar/fout):', e.message);
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {} // ruim halve output op
    return file.filename; // behoud origineel
  }
}

export default { toWebp };
