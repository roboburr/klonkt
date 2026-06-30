/**
 * VideoCoverService — turn an animated cover into a small, Safari-friendly muted loop video.
 *
 * Safari renders animated WebP poorly; a muted <video> loop plays smoothly everywhere (iOS too).
 * ffmpeg-static can't DECODE an animated WebP, so we decode it with node-webpmux (pure JS/WASM,
 * NO native deps → installs on every platform, never breaks `npm ci`) into RGBA frames, then
 * encode with the bundled ffmpeg-static into an H.264 MP4 (yuv420p + faststart + no audio) plus a
 * JPG poster frame. A real uploaded video goes straight through ffmpeg. Both are best-effort: on
 * any failure we return null and the caller keeps the still image.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import WebP from 'node-webpmux';

const execFileP = promisify(execFile);
const MAX_SECONDS = 60; // cap a cover loop at one minute

let _lib = null;
function ensureLib() { if (!_lib) _lib = WebP.Image.initLib(); return _lib; }

// node-webpmux's getFrameData(i) returns ONLY frame i's own sub-region (x,y,width,height) — it does
// NOT composite onto the canvas. Real (tool-made) animated WebPs use partial frames of varying size,
// so we composite each onto a persistent W×H canvas (honoring blend + dispose) and emit consistent
// full frames. Feeding ffmpeg the raw varying-size sub-regions desyncs the stream → a torn/tiled video.
async function compositeFrames(img) {
  const W = img.width, H = img.height, frames = img.anim.frames;
  const canvas = Buffer.alloc(W * H * 4); // transparent black
  const out = [];
  let prev = null; // previous frame's rect + dispose
  for (let i = 0; i < frames.length; i++) {
    const fr = frames[i];
    if (prev && prev.dispose) { // dispose-to-background: clear the previous frame's rect first
      for (let row = 0; row < prev.h; row++) {
        const y = prev.y + row; if (y < 0 || y >= H) continue;
        canvas.fill(0, (y * W + prev.x) * 4, (y * W + prev.x + prev.w) * 4);
      }
    }
    const data = Buffer.from(await img.getFrameData(i)); // fr.width*fr.height*4 RGBA sub-region
    // node-webpmux returns the raw ANMF offset, which the WebP spec stores as actual/2 (frame
    // offsets are always even); libwebp/webpmux double it. So ×2 the x/y to get the true pixel
    // position — else partial frames land at half-offset and ghost over the base. width/height are fine.
    const fx = fr.x * 2, fy = fr.y * 2, fw = fr.width, fh = fr.height, blend = fr.blend;
    if (fx === 0 && fy === 0 && fw === W && fh === H && !blend) {
      data.copy(canvas, 0); // full opaque overwrite (the typical base frame)
    } else {
      for (let row = 0; row < fh; row++) {
        const cy = fy + row; if (cy < 0 || cy >= H) continue;
        for (let col = 0; col < fw; col++) {
          const cx = fx + col; if (cx < 0 || cx >= W) continue;
          const s = (row * fw + col) * 4, d = (cy * W + cx) * 4, sa = data[s + 3];
          if (!blend || sa === 255) { canvas[d] = data[s]; canvas[d + 1] = data[s + 1]; canvas[d + 2] = data[s + 2]; canvas[d + 3] = sa; }
          else if (sa !== 0) { // alpha-over the existing canvas pixel
            const a = sa / 255, ia = 1 - a;
            canvas[d]     = (data[s]     * a + canvas[d]     * ia) | 0;
            canvas[d + 1] = (data[s + 1] * a + canvas[d + 1] * ia) | 0;
            canvas[d + 2] = (data[s + 2] * a + canvas[d + 2] * ia) | 0;
            canvas[d + 3] = Math.min(255, sa + ((canvas[d + 3] * ia) | 0));
          }
        }
      }
    }
    out.push(Buffer.from(canvas)); // snapshot the full composited canvas
    prev = { x: fx, y: fy, w: fw, h: fh, dispose: fr.dispose };
  }
  return Buffer.concat(out);
}

// True if the file is an animated WebP (a VP8X chunk with the animation flag set).
export function isAnimatedWebp(filePath) {
  try {
    if (path.extname(filePath).toLowerCase() !== '.webp') return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const b = Buffer.alloc(40);
      const n = fs.readSync(fd, b, 0, 40, 0);
      return n >= 21 && b.toString('ascii', 12, 16) === 'VP8X' && (b[20] & 0x02) !== 0;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

// Animated WebP → muted loop MP4 + JPG poster. Returns { videoPath, posterPath } or null.
export async function animatedWebpToVideo(srcPath, outDir, baseName) {
  let rawPath = null;
  try {
    if (!ffmpegPath) return null;
    await ensureLib();
    const img = new WebP.Image();
    await img.load(srcPath);
    if (!img.hasAnim || !img.anim || !Array.isArray(img.anim.frames) || img.anim.frames.length < 2) return null;
    const W = img.width, H = img.height;
    const fps = Math.max(1, Math.min(30, Math.round(1000 / (img.anim.frames[0].delay || 100))));
    await fs.promises.mkdir(outDir, { recursive: true });
    rawPath = path.join(outDir, baseName + '.rgba.tmp');
    await fs.promises.writeFile(rawPath, await compositeFrames(img)); // full composited W×H frames
    const videoPath = path.join(outDir, baseName + '.mp4');
    const posterPath = path.join(outDir, baseName + '.jpg');
    await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', rawPath,
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', // yuv420p needs even dimensions
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', videoPath],
      { timeout: 60000 });
    await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', rawPath,
      '-frames:v', '1', '-y', posterPath], { timeout: 30000 });
    return { videoPath, posterPath };
  } catch (e) {
    console.warn('[videocover] animated webp → mp4 failed:', e.message);
    return null;
  } finally {
    if (rawPath) try { await fs.promises.unlink(rawPath); } catch { /* ignore */ }
  }
}

// An uploaded video → muted loop MP4 (scaled ≤1280w, capped 60s) + JPG poster. ffmpeg decodes
// every video format, so no node-webpmux here. Returns { videoPath, posterPath } or null.
export async function videoToLoop(srcPath, outDir, baseName) {
  try {
    if (!ffmpegPath) return null;
    await fs.promises.mkdir(outDir, { recursive: true });
    const videoPath = path.join(outDir, baseName + '.mp4');
    const posterPath = path.join(outDir, baseName + '.jpg');
    await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-i', srcPath, '-t', String(MAX_SECONDS),
      '-vf', "scale='min(1280,iw)':-2,pad=ceil(iw/2)*2:ceil(ih/2)*2",
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', videoPath],
      { timeout: 120000 });
    await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-i', videoPath, '-frames:v', '1', '-y', posterPath], { timeout: 30000 });
    return { videoPath, posterPath };
  } catch (e) {
    console.warn('[videocover] video → loop failed:', e.message);
    return null;
  }
}

export default { isAnimatedWebp, animatedWebpToVideo, videoToLoop };
