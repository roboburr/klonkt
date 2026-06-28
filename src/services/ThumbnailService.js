/**
 * On-demand cover thumbnails.
 *
 * High-res covers (especially line-art) look jagged because the BROWSER downscales
 * them to the small grid/list size. We instead downscale the stored original
 * server-side with ffmpeg's lanczos filter to a small WebP and cache it on disk, so
 * the browser receives a near-1:1 image → crisp lines.
 *
 * No re-upload / backfill: the original file is only READ, never modified, and
 * thumbnails are generated lazily on first request. Cover filenames are content-
 * hashed/UUID, so a cached thumbnail can never go stale (a new cover = a new name).
 *
 * Uses the bundled `ffmpeg-static` (always present); cwebp is not required here.
 */
import { execFile } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const execFileP = promisify(execFile);

// Allowed widths (whitelist → no arbitrary-size abuse). 480 ≈ 2× a grid tile (retina).
export const THUMB_SIZES = new Set([320, 480, 640]);

let _seq = 0;

function mediaRoot() {
  return path.resolve(process.env.MEDIA_PATH || './storage/media');
}

// Resolve a safe absolute path for a relative media path; null on traversal attempts.
function safeOriginal(rel) {
  const root = mediaRoot();
  const orig = path.resolve(root, rel);
  if (orig !== root && !orig.startsWith(root + path.sep)) return null;
  return orig;
}

/**
 * Return the on-disk path of the cached thumbnail, generating it if needed.
 * @returns {Promise<string|null>} absolute path, or null if it can't be produced.
 */
export async function getThumbnail(rel, width) {
  if (!THUMB_SIZES.has(width) || !ffmpegPath || !rel) return null;
  const orig = safeOriginal(rel);
  if (!orig || !fs.existsSync(orig)) return null;

  const root = mediaRoot();
  // Cache under <media>/.thumbs/<w>/<rel>.webp (dotted dir → never collides with media).
  const cached = path.join(root, '.thumbs', String(width), rel) + '.webp';
  if (fs.existsSync(cached)) return cached;

  await fs.promises.mkdir(path.dirname(cached), { recursive: true });
  const tmp = `${cached}.tmp-${process.pid}-${_seq++}`;
  try {
    await execFileP(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', orig,
      // Downscale to `width` (never upscale past the original) with lanczos; even height.
      '-vf', `scale='min(${width},iw)':-2:flags=lanczos`,
      '-frames:v', '1',
      '-c:v', 'libwebp', '-q:v', '82',
      // Force the WebP muxer: the tmp filename has no .webp extension, so ffmpeg
      // can't infer the output format from it.
      '-f', 'webp',
      tmp,
    ], { timeout: 20000 });
    await fs.promises.rename(tmp, cached);
    return cached;
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch {}
    console.warn('[thumb] generation failed for', rel, '-', e.message);
    return null;
  }
}
