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
