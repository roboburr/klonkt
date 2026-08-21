/**
 * Where user data lives on disk.
 *
 * Every media subdirectory derives from MEDIA_PATH, so one setting moves the
 * whole media tree out of the checkout. That matters because the deploy checks
 * out the work-tree: anything the app writes next to its own code can be wiped
 * by a cleanup on the next deploy.
 *
 * Read at import time, like the rest of the config. `dotenv/config` is the first
 * import in server.js, so the environment is already populated by the time this
 * module is evaluated.
 */
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Root for public, user-uploaded media (served by the /media handler). */
export const MEDIA_ROOT = path.resolve(
  process.env.MEDIA_PATH || path.join(__dirname, '..', '..', 'storage', 'media')
);

/**
 * Resolve one media subdirectory.
 *
 * A per-subdirectory variable still wins, so installs that already pin an
 * individual path keep working. Only the fallback changed: it now follows
 * MEDIA_ROOT instead of pointing back into the checkout.
 *
 * @param {string} envVar  per-subdirectory override, e.g. 'AVATAR_PATH'
 * @param {string} sub     subdirectory name under MEDIA_ROOT, e.g. 'avatars'
 */
export function mediaDir(envVar, sub) {
  return path.resolve(process.env[envVar] || path.join(MEDIA_ROOT, sub));
}

/**
 * Waar de gehoste audio staat.
 *
 * BEWUST BUITEN MEDIA_ROOT: de publieke /media-handler mag er niet bij, elke
 * fetch loopt via de gated route in routes/audio.js. Diezelfde route resolvet
 * met AUDIO_DIR + bestandsnaam, en negeert media.storage_path volledig.
 */
export const AUDIO_ROOT = path.resolve(
  process.env.AUDIO_PATH || path.join(__dirname, '..', '..', 'storage', 'audio'),
);

/**
 * Het echte pad van een audiobestand, op DEZELFDE manier als de speler het zoekt.
 *
 * Dit bestaat omdat die twee uit elkaar liepen en dat een verhuizing sloopte.
 * Op sound-fabrics.com wees media.storage_path voor 124 van de 139 tracks nog
 * naar /srv/prutfolio/storage/audio (van voor de dataverhuizing), terwijl de
 * bestanden allang op ~/data/prutfolio/audio stonden. De site merkte er niets
 * van, want de speler kijkt alleen naar de bestandsnaam. De exporter las wel
 * storage_path, vond niets, en liet 124 nummers stil achter.
 *
 * Volgorde: eerst zoals de speler kijkt (bestandsnaam in AUDIO_ROOT), dan pas
 * het opgeslagen pad. Zo klopt de export met wat de gebruiker hoort, en niet
 * met wat de database ooit dacht.
 *
 * @returns {string|null} een bestaand pad, of null
 */
export function resolveAudioPath(storagePath, fs) {
  const s = String(storagePath || '');
  if (!s) return null;
  const kandidaten = [path.join(AUDIO_ROOT, path.basename(s)), path.resolve(s)];
  for (const p of kandidaten) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* volgende kandidaat */ }
  }
  return null;
}
