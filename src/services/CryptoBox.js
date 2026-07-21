// Symmetric encryption for secrets at rest (paid posts: the site owner's
// Patreon creator token, klonkt-demo-aki slice 1). AES-256-GCM with a key
// derived from a secret, so a database dump alone leaks nothing usable.
// Format: base64(iv) : base64(tag) : base64(ciphertext).
//
// The secret is resolved in this order so nobody has to edit the env:
//   1. PAID_SECRET (env) — authoritative; a self-hoster who set it by hand
//      (or Bart, who already did) keeps working unchanged.
//   2. a persisted key file next to the database, auto-generated on first use
//      (0600). This is what "first run" and "existing users after an update"
//      get automatically.
// The key lives OUTSIDE the sqlite DB on purpose: encrypting the Patreon
// secrets is pointless if the key sits in the same file a DB dump would leak.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The key file sits in the same directory as the database.
function keyFilePath() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../storage/database.sqlite');
  const dir = dbPath === ':memory:' ? path.join(__dirname, '../../storage') : path.dirname(dbPath);
  return path.join(dir, '.paid-secret');
}

// Read the persisted key, generating + writing it (0600) the first time.
function fileSecret() {
  const file = keyFilePath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch { /* not created yet */ }
  const generated = crypto.randomBytes(32).toString('base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX fs */ }
  return generated;
}

// env wins; otherwise the auto-generated file. Never returns an ephemeral key:
// if the file can't be persisted, fileSecret throws and the feature stays gated
// (cryptoBoxReady false) rather than encrypting with a key lost on restart.
function resolveSecret() {
  const env = process.env.PAID_SECRET;
  if (env && String(env).length >= 16) return String(env);
  return fileSecret();
}

let _key = null;
function key() {
  if (_key) return _key;
  _key = crypto.scryptSync(resolveSecret(), 'klonkt-paid', 32);
  return _key;
}

// True when a key is configured, so callers can gate the feature instead of throwing.
export function cryptoBoxReady() {
  try { key(); return true; } catch { return false; }
}

export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(blob) {
  if (blob == null || blob === '') return null;
  const parts = String(blob).split(':');
  if (parts.length !== 3) throw new Error('malformed ciphertext');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// The stateless signed blob reused for the OAuth state and the WebAuthn
// challenge (design doc "cookie-less trick"): HMAC over a short-lived payload,
// so no server session is needed to bind pending state to a browser.
export function signBlob(payload, ttlSeconds = 600) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: crypto.randomBytes(8).toString('hex') };
  const b = Buffer.from(JSON.stringify(body)).toString('base64url');
  const tag = crypto.createHmac('sha256', key()).update(b).digest('base64url');
  return `${b}.${tag}`;
}

// Returns the payload if valid and unexpired, else null. Constant-time tag check.
export function verifyBlob(token) {
  const [b, tag] = String(token || '').split('.');
  if (!b || !tag) return null;
  const expected = crypto.createHmac('sha256', key()).update(b).digest('base64url');
  const a = Buffer.from(tag); const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null;
  let payload; try { payload = JSON.parse(Buffer.from(b, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || (payload.exp && payload.exp * 1000 < Date.now())) return null;
  return payload;
}
