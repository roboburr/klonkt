/**
 * Audio transcoder — convert uploads to a uniform mp3 format.
 *
 * Settings: 192 kbps CBR, stereo, 44.1 kHz. Reasonable balance of size
 * (~1.4 MB/min) and quality for music. Any input format ffmpeg can read
 * is accepted (mp3, m4a, ogg, opus, flac, wav, webm, etc).
 *
 * The transcode pipeline:
 *   1. Read source from `inputPath` (the multer-stored upload)
 *   2. Write transcoded mp3 to a tmp file in the same directory
 *   3. On success: delete original, rename tmp to final `<id>.mp3`
 *   4. On failure: delete tmp (if exists), KEEP original so caller can
 *      decide what to do (we don't want to lose user data on ffmpeg quirks)
 *
 * Tags (title/artist/album) are baked into the mp3 ID3v2 metadata so a
 * downloader sees them in their music player.
 */

import path from 'path';
import fs from 'fs';
import { promisify } from 'util';
import ffmpeg from 'fluent-ffmpeg';

// ffmpeg-static is a SOFT dependency. We import it dynamically so that:
//   (a) If the package isn't installed (e.g. dev environment), we don't crash
//   (b) If its postinstall failed to download the binary (sandboxed CI,
//       proxy, GitHub release CDN issues), we don't crash
// In either case we fall back to whatever `ffmpeg` is on PATH. fluent-ffmpeg
// will pick that up automatically when no explicit path is set.
//
// `await import()` of a CommonJS package on Node returns a Module Namespace
// Object. ffmpeg-static exports `module.exports = "/path/to/ffmpeg.exe"` —
// a bare string — which Node wraps so the actual path lives at .default.
// On some Node versions / interop shims it may also be reachable via the
// raw export. We try several shapes to be defensive.
let FFMPEG_BIN = null;
try {
  const mod = await import('ffmpeg-static');
  // Prefer .default (Node ESM-CJS interop), then root (older interop), then
  // .path (some forks). Reject anything that isn't a string or doesn't exist.
  const candidates = [mod?.default, mod, mod?.path];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) {
      try {
        if (fs.statSync(c).isFile()) { FFMPEG_BIN = c; break; }
      } catch { /* candidate doesn't exist on disk, try next */ }
    }
  }
} catch (e) {
  console.warn('[audio-transcoder] ffmpeg-static import failed:', e.message);
}

if (FFMPEG_BIN) {
  ffmpeg.setFfmpegPath(FFMPEG_BIN);
  console.log('[audio-transcoder] using ffmpeg-static binary at', FFMPEG_BIN);
} else {
  console.warn('[audio-transcoder] ffmpeg-static not available — using system ffmpeg from PATH.');
}

const unlink = promisify(fs.unlink);
const rename = promisify(fs.rename);
const stat = promisify(fs.stat);

/**
 * Transcode a source audio file to 192kbps stereo mp3.
 *
 * @param {object} opts
 * @param {string} opts.inputPath  Absolute path of the source file (will be deleted on success).
 * @param {string} opts.outputDir  Directory to write the final mp3 into.
 * @param {string} opts.outputBaseName  Base filename WITHOUT extension; ".mp3" is added.
 * @param {object} [opts.tags]     Optional ID3 tags { title, artist, album }.
 *
 * @returns {Promise<{filename: string, path: string, size: number, mimeType: 'audio/mpeg'}>}
 *          On success the original `inputPath` has been deleted.
 *
 * @throws  Error if ffmpeg fails, the input is unreadable, or the output is empty.
 *          On error: tmp file cleaned up; original is left in place.
 */
export async function transcodeToMp3({ inputPath, outputDir, outputBaseName, tags = {} }) {
  if (!inputPath || !outputDir || !outputBaseName) {
    throw new Error('transcodeToMp3: inputPath, outputDir, outputBaseName required');
  }
  // Sanity check input exists
  await stat(inputPath); // throws ENOENT if missing — let caller handle

  const finalFilename = `${outputBaseName}.mp3`;
  const finalPath = path.join(outputDir, finalFilename);
  // Tmp lives next to final so the rename is atomic on most filesystems
  // (same partition guaranteed). Suffix avoids collisions between concurrent transcodes.
  const tmpPath = path.join(outputDir, `${outputBaseName}.transcoding-${process.pid}.mp3`);

  let durationSec = null;
  try {
    const r = await runFfmpeg({ inputPath, tmpPath, tags });
    durationSec = r && r.durationSec != null ? r.durationSec : null;

    // Verify the output is not zero bytes — ffmpeg sometimes "succeeds" but
    // produces empty output for unreadable inputs. Better to fail loudly here.
    const outStat = await stat(tmpPath);
    if (outStat.size === 0) {
      throw new Error('Transcoded output is empty (input may be corrupt)');
    }

    // Atomic move: tmp -> final. If a file already exists at final (shouldn't
    // happen because outputBaseName is a fresh uuid) rename overwrites on POSIX
    // and on Windows from Node 18+.
    await rename(tmpPath, finalPath);

    // Original is no longer needed — delete it. If this fails we still keep
    // the transcoded mp3; the original will just be orphaned (not catastrophic).
    //
    // CRITICAL: if the input was already an .mp3, multer stored it as
    // <uuid>.mp3 and our finalFilename is also <uuid>.mp3 — same path. The
    // rename() above already replaced the original file with the transcoded
    // version, so deleting inputPath here would delete the FINAL file.
    // Use path.resolve to compare normalised forms (handles Windows
    // case-insensitivity and slash flavour).
    if (path.resolve(inputPath) !== path.resolve(finalPath)) {
      try { await unlink(inputPath); }
      catch (e) { console.warn('[audio-transcoder] could not delete original:', inputPath, e.message); }
    }

    return {
      filename: finalFilename,
      path: finalPath,
      size: outStat.size,
      mimeType: 'audio/mpeg',
      durationSec,   // whole seconds from ffmpeg's codecData (null if unknown)
    };

  } catch (err) {
    // Clean up tmp if it exists; leave original alone so the caller can
    // surface an error and the user's upload isn't lost.
    try { await unlink(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
}

/**
 * Rewrite the ID3 tags of an EXISTING mp3 without re-encoding (`-c copy`).
 * Used when editing track metadata (title/artist/album/credit/license) so that
 * ownership info travels with the file on download.
 * ffmpeg cannot edit in-place → write to tmp and atomically rename back.
 */
export async function retagMp3({ filePath, tags = {} }) {
  if (!filePath) throw new Error('retagMp3: filePath required');
  await stat(filePath); // throws if file is missing
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const tmpPath = path.join(dir, `${base}.retag-${process.pid}.mp3`);
  try {
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(filePath)
        .audioCodec('copy')        // no re-encode → fast, no quality loss
        .format('mp3')
        .outputOptions('-id3v2_version', '3')
        .outputOptions('-map_metadata', '-1')
        .outputOptions('-vn');
      if (tags.title)     cmd.outputOptions('-metadata', `title=${tags.title}`);
      if (tags.artist)    cmd.outputOptions('-metadata', `artist=${tags.artist}`);
      if (tags.album)     cmd.outputOptions('-metadata', `album=${tags.album}`);
      if (tags.copyright) cmd.outputOptions('-metadata', `copyright=${tags.copyright}`);
      if (tags.comment)   cmd.outputOptions('-metadata', `comment=${tags.comment}`);
      cmd.on('error', (err, so, se) => reject(new Error(((err && err.message) || 'ffmpeg') + (se ? ' | ' + se : ''))))
         .on('end', () => resolve())
         .save(tmpPath);
    });
    const s = await stat(tmpPath);
    if (s.size === 0) throw new Error('retag output is empty');
    await rename(tmpPath, filePath);
    return { filePath, size: s.size };
  } catch (err) {
    try { await unlink(tmpPath); } catch { /* tmp may not exist */ }
    throw err;
  }
}

/**
 * Run a single ffmpeg pass: input -> tmp output.
 * Returns a promise that resolves when ffmpeg exits cleanly, rejects otherwise.
 */
function runFfmpeg({ inputPath, tmpPath, tags }) {
  return new Promise((resolve, reject) => {
    let durationSec = null;
    const cmd = ffmpeg(inputPath)
      .audioCodec('libmp3lame')
      .audioBitrate('192k')          // CBR — easier seeking than VBR for our small <50MB files
      .audioChannels(2)              // force stereo (mono inputs get duplicated; multichannel downmixed)
      .audioFrequency(44100)         // 44.1 kHz: standard for music
      .format('mp3')
      // ID3v2.3 is the most widely-supported tag version (Windows Explorer,
      // older players). v2.4 has UTF-8 support but breaks some clients.
      .outputOptions('-id3v2_version', '3')
      // Always rewrite tags from scratch — don't let stale frames from the
      // input file leak through.
      .outputOptions('-map_metadata', '-1')
      // Strip video/album-art streams. We attach our own cover separately
      // (via the audio_tracks.cover_url column). Embedding here would just
      // bloat the mp3.
      .outputOptions('-vn');

    // Bake tags as ID3 frames if the caller provided any.
    // CRITICAL: pass `-metadata` and the `key=value` string as TWO separate
    // arguments so fluent-ffmpeg sends them as two argv slots. If we pass
    // them as a single string fluent-ffmpeg splits on whitespace, which
    // breaks any value containing a space (e.g. "Test Artist" gets parsed
    // as a separate output filename).
    if (tags.title)     cmd.outputOptions('-metadata', `title=${tags.title}`);
    if (tags.artist)    cmd.outputOptions('-metadata', `artist=${tags.artist}`);
    if (tags.album)     cmd.outputOptions('-metadata', `album=${tags.album}`);
    if (tags.copyright) cmd.outputOptions('-metadata', `copyright=${tags.copyright}`); // ID3 TCOP — owner/credit
    if (tags.comment)   cmd.outputOptions('-metadata', `comment=${tags.comment}`);     // ID3 COMM — license

    cmd
      // codecData gives the INPUT duration as "HH:MM:SS.xx" — this lets us
      // determine the track length automatically without a separate ffprobe binary.
      .on('codecData', (data) => { durationSec = parseHmsToSeconds(data && data.duration); })
      .on('error', (err, stdout, stderr) => {
        // ffmpeg's stderr is the most useful diagnostic. fluent-ffmpeg's
        // err.message is usually a short summary; we glue stderr on so the
        // log captures the actual failure reason.
        const reason = err.message || 'ffmpeg failed';
        const tail = (stderr || '').split('\n').slice(-6).join('\n').trim();
        reject(new Error(`Transcode failed: ${reason}${tail ? '\n' + tail : ''}`));
      })
      .on('end', () => resolve({ durationSec }))
      .save(tmpPath);
  });
}

/**
 * Parse an ffmpeg duration string "HH:MM:SS.xx" to whole seconds. Returns null
 * for "N/A" or an unexpected format.
 */
function parseHmsToSeconds(hms) {
  if (!hms || typeof hms !== 'string') return null;
  const m = hms.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return null;
  const sec = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? Number('0.' + m[4]) : 0);
  return Number.isFinite(sec) ? Math.round(sec) : null;
}

/**
 * Read the duration (whole seconds) of an audio file WITHOUT transcoding.
 * Starts an ffmpeg pass and reads only the codecData event (duration), then
 * kills the process immediately — fast and without a separate ffprobe binary
 * (ffmpeg-static ships only ffmpeg). Intended for the backfill script.
 * @returns {Promise<number|null>}
 */
export function probeDuration(filePath) {
  return new Promise((resolve) => {
    let durationSec = null, done = false;
    const finish = () => { if (!done) { done = true; resolve(durationSec); } };
    const cmd = ffmpeg(filePath)
      .on('codecData', (data) => {
        durationSec = parseHmsToSeconds(data && data.duration);
        try { cmd.kill('SIGKILL'); } catch { /* already done */ }
        finish();
      })
      .on('error', finish)
      .on('end', finish)
      .format('null')
      .save(process.platform === 'win32' ? 'NUL' : '/dev/null');
  });
}

export default { transcodeToMp3, probeDuration };
