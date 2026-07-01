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
import crypto from 'crypto';
import { promisify } from 'util';
import { safeFetch } from './ActivityPubService.js';

const execFileP = promisify(execFile);

// Allowed widths (whitelist → no arbitrary-size abuse). 96 = small feed/comment avatars
// (~44px); 128 = nav/profile avatars; 256 ≈ 2× a list cover; 480 ≈ 2× a grid tile; 1280 =
// full-width timeline media (crisp on mobile retina, ~430px × 3 DPR). Keep these ~2× the
// display size so the browser barely scales (avoids both jaggies and upscaling blur).
export const THUMB_SIZES = new Set([96, 128, 256, 320, 480, 640, 1280]);

let _seq = 0;

// Limit concurrent ffmpeg spawns. A cold-cache, image-heavy page fires many thumbnail
// requests at once; without a cap each spawns its own ffmpeg → CPU saturation makes the
// WHOLE instance slow (the thundering herd). With the cap, excess requests wait briefly
// for a slot → bounded CPU, the page still loads (images just appear progressively).
const MAX_CONCURRENT = 3;
let _active = 0;
const _waiters = [];
function acquireSlot() {
  if (_active < MAX_CONCURRENT) { _active++; return Promise.resolve(); }
  return new Promise((resolve) => _waiters.push(resolve));
}
function releaseSlot() {
  const next = _waiters.shift();
  if (next) next();      // transfer the slot directly to the next waiter (_active unchanged)
  else _active--;
}
async function runFfmpeg(args) {
  await acquireSlot();
  try { await execFileP(ffmpegPath, args, { timeout: 20000 }); }
  finally { releaseSlot(); }
}

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

// Is the source an animated image (animated WebP or GIF)? If so the thumbnail must keep ALL
// frames (a downscaled animated WebP) instead of grabbing a single frame — otherwise an
// animated cover shows up frozen on the site.
function isAnimatedSrc(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.gif') return true; // a flattened GIF would lose its animation too
    if (ext !== '.webp') return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(40);
      const n = fs.readSync(fd, buf, 0, 40, 0);
      // RIFF…WEBP, then a VP8X chunk (bytes 12-15) whose flags byte (20) has the animation bit.
      return n >= 21 && buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
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

  // ffmpeg-static can't decode an animated WebP ("image data not found"), so we can't make a
  // scaled animated thumbnail. Return null → the route serves the ORIGINAL instead, which keeps
  // animating. (Animated covers are usually already small, so skipping the downscale is fine.)
  if (isAnimatedSrc(orig)) return null;

  await fs.promises.mkdir(path.dirname(cached), { recursive: true });
  const tmp = `${cached}.tmp-${process.pid}-${_seq++}`;
  try {
    await runFfmpeg([
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
    ]);
    await fs.promises.rename(tmp, cached);
    return cached;
  } catch (e) {
    try { await fs.promises.unlink(tmp); } catch {}
    console.warn('[thumb] generation failed for', rel, '-', e.message);
    return null;
  }
}

// ── Signed remote-image proxy ─────────────────────────────────────
// Remote avatars/images (fediverse) live on OTHER servers, so we fetch them once
// (SSRF-safe via safeFetch), downscale them identically, and cache. The proxy URL is
// HMAC-signed so it can't be abused as an open image-resizer: only URLs that Klonkt
// itself rendered are accepted.

let _key;
function imgKey() {
  if (_key) return _key;
  _key = process.env.SESSION_SECRET || '';
  if (!_key) {
    try {
      const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH || './storage/database.sqlite'));
      _key = fs.readFileSync(path.join(dataDir, '.session-secret'), 'utf8').trim();
    } catch { _key = 'klonkt-img-proxy'; }
  }
  return _key;
}

function sign(url, w) {
  return crypto.createHmac('sha256', imgKey()).update(`${w}:${url}`).digest('hex').slice(0, 24);
}

// Signed proxy URL for a remote image (used by the avatar() view helper).
export function imgProxyUrl(url, width) {
  return `/img/a/${width}?u=${encodeURIComponent(url)}&s=${sign(url, width)}`;
}

export function verifyImg(url, width, sig) {
  if (!sig || !url) return false;
  let want;
  try { want = sign(url, width); } catch { return false; }
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); } catch { return false; }
}

/**
 * Fetch a remote image (SSRF-safe), downscale to `width` (lanczos → WebP), cache it.
 * @returns {Promise<string|null>} cached path, or null.
 */
// Same animation check as isAnimatedSrc but on an in-memory buffer (remote fetch): ffmpeg-static
// can't decode an animated WebP, and flattening a GIF/animated WebP to one frame loses its motion.
function isAnimatedBuf(buf) {
  try {
    if (!buf || buf.length < 21) return false;
    if (buf.toString('ascii', 0, 3) === 'GIF') return true; // any GIF (a flattened one loses its animation)
    // Animated WebP: RIFF…WEBP with a VP8X chunk whose flags byte (20) has the animation bit (0x02).
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP'
        && buf.toString('ascii', 12, 16) === 'VP8X' && (buf[20] & 0x02) !== 0) return true;
    return false;
  } catch { return false; }
}
export async function getRemoteThumbnail(url, width) {
  if (!THUMB_SIZES.has(width) || !ffmpegPath || !url) return null;
  const root = mediaRoot();
  const hash = crypto.createHash('sha256').update(url).digest('hex');
  // Remote filenames are content-hashed (Mastodon/Klonkt) → URL-keyed cache never stales.
  const cached = path.join(root, '.thumbs', 'remote', String(width), `${hash}.webp`);
  if (fs.existsSync(cached)) return cached;

  let buf;
  try {
    const r = await safeFetch(url);
    if (!r.ok) return null;
    if (!(r.headers.get('content-type') || '').startsWith('image/')) return null;
    if (parseInt(r.headers.get('content-length') || '0', 10) > 12 * 1024 * 1024) return null;
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.warn('[thumb-remote] fetch failed for', url, '-', e.message);
    return null;
  }
  if (buf.length > 12 * 1024 * 1024) return null;
  // ffmpeg-static can't decode an animated WebP (the doomed downscale just logs an error), and a
  // flattened GIF/animated WebP loses its motion → skip it and let the route serve the ORIGINAL
  // (keeps the animation; mirrors the local path's isAnimatedSrc guard).
  if (isAnimatedBuf(buf)) return null;

  await fs.promises.mkdir(path.dirname(cached), { recursive: true });
  const tmpIn = `${cached}.in-${process.pid}-${_seq++}`;
  const tmpOut = `${cached}.out-${process.pid}-${_seq++}`;
  try {
    await fs.promises.writeFile(tmpIn, buf);
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', tmpIn,
      '-vf', `scale='min(${width},iw)':-2:flags=lanczos`,
      '-frames:v', '1',
      '-c:v', 'libwebp', '-q:v', '82', '-f', 'webp',
      tmpOut,
    ]);
    await fs.promises.rename(tmpOut, cached);
    return cached;
  } catch (e) {
    console.warn('[thumb-remote] downscale failed for', url, '-', e.message);
    return null;
  } finally {
    fs.promises.unlink(tmpIn).catch(() => {});
    fs.promises.unlink(tmpOut).catch(() => {});
  }
}
