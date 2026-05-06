/**
 * AudioStreamService — Signed audio streaming, v9-style.
 *
 * The src of <audio> is /audio/stream/:filename?t=HMAC&exp=TIMESTAMP.
 * HMAC = SHA256(filename|exp|AUDIO_SECRET).
 *
 * Defeats hotlinking, scrapers, casual URL sharing — not state actors.
 * Token TTL: 10 minutes (long enough for a track, short enough that a
 * shared link expires before anyone can use it).
 *
 * AUDIO_SECRET comes from env. If missing on first boot, generate one
 * and persist to storage/.audio-secret so it survives restarts.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, '..', '..', 'storage', '.audio-secret');

export const TOKEN_TTL_SECONDS = 600;

let cachedSecret = null;

function loadOrGenerateSecret() {
  if (cachedSecret) return cachedSecret;

  // 1. Env wins
  if (process.env.AUDIO_SECRET && process.env.AUDIO_SECRET.length >= 32) {
    cachedSecret = process.env.AUDIO_SECRET;
    return cachedSecret;
  }

  // 2. Persisted file
  try {
    const fromDisk = fs.readFileSync(SECRET_FILE, 'utf-8').trim();
    if (fromDisk.length >= 32) {
      cachedSecret = fromDisk;
      return cachedSecret;
    }
  } catch (e) { /* file missing — generate */ }

  // 3. Generate + persist
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
    console.log('AudioStreamService: generated new audio secret at', SECRET_FILE);
  } catch (e) {
    console.error('AudioStreamService: could not persist audio secret:', e.message);
  }
  cachedSecret = generated;
  return cachedSecret;
}

function makeHmac(filename, exp) {
  const secret = loadOrGenerateSecret();
  return crypto
    .createHmac('sha256', secret)
    .update(`${filename}|${exp}`)
    .digest('hex');
}

/**
 * Sign a filename → returns { url, exp, t } so callers can build the URL.
 * The full URL is /audio/stream/<filename>?t=<t>&exp=<exp>.
 */
export function signUrl(filename, ttlSeconds = TOKEN_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const t = makeHmac(filename, exp);
  const safe = encodeURIComponent(filename);
  return {
    url: `/audio/stream/${safe}?t=${t}&exp=${exp}`,
    exp,
    t,
  };
}

/**
 * Verify a token for a filename. Returns true iff exp is in the future
 * AND the HMAC matches.
 */
export function verifyToken(filename, t, exp) {
  if (!filename || !t || !exp) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum)) return false;
  if (expNum < Math.floor(Date.now() / 1000)) return false;

  const expected = makeHmac(filename, expNum);
  // timingSafeEqual requires equal-length buffers
  try {
    const a = Buffer.from(t, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

/**
 * Force-rotate the secret. Invalidates all outstanding tokens.
 */
export function rotateSecret() {
  cachedSecret = null;
  try { fs.unlinkSync(SECRET_FILE); } catch (e) {}
  return loadOrGenerateSecret();
}

export default { signUrl, verifyToken, rotateSecret, TOKEN_TTL_SECONDS };
