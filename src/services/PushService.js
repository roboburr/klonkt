// Web Push (VAPID) — background notifications to the owner's browser/PWA
// (docs/webpush-design.md). RFC 8030 delivery + RFC 8291 payload encryption via
// the `web-push` dependency (approved); the push service only ever sees
// ciphertext. No cookies anywhere: only enabling/disabling is a logged-in action.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../config/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Lazy so a not-yet-installed dependency can never crash app boot; only push
// fails until `npm ci` has run (same pattern as @simplewebauthn/server).
let _lib = null;
async function lib() {
  if (!_lib) { const m = await import('web-push'); _lib = m.default || m; }  // CJS: API on default
  return _lib;
}

// ── VAPID keys ──────────────────────────────────────────────────────
// env wins; otherwise a persisted key file next to the database, generated on
// first use. NEVER regenerated while the file exists: new keys invalidate every
// existing subscription. Back up storage/ as a whole (README).

function keyFilePath() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../storage/database.sqlite');
  const dir = dbPath === ':memory:' ? path.join(__dirname, '../../storage') : path.dirname(dbPath);
  return path.join(dir, '.vapid');
}

// The VAPID subject: an https URL (PUBLIC_BASE_URL) or a mailto.
function subject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (/^https:\/\//.test(base)) return base;
  const from = (process.env.SMTP_FROM || '').replace(/^.*</, '').replace(/>.*$/, '').trim();
  return from.includes('@') ? `mailto:${from}` : 'mailto:webpush@invalid.local';
}

let _keys = null;
async function vapidKeys() {
  if (_keys) return _keys;
  const envPub = process.env.VAPID_PUBLIC_KEY, envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) { _keys = { publicKey: envPub, privateKey: envPriv }; return _keys; }
  const file = keyFilePath();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.publicKey && j.privateKey) { _keys = j; return _keys; }
  } catch { /* not created yet */ }
  const { generateVAPIDKeys } = await lib();
  const fresh = generateVAPIDKeys();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fresh), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX fs */ }
  _keys = fresh;
  return _keys;
}

// The public key for the client (pushManager.subscribe). Null when the
// dependency is missing or the key can't be persisted → feature stays gated.
export async function publicKey() {
  try { return (await vapidKeys()).publicKey; } catch { return null; }
}

export async function pushReady() { return (await publicKey()) !== null; }

// ── Subscriptions ───────────────────────────────────────────────────

export const DEFAULT_ALERTS = { follow: 1, reply: 1, like: 0, boost: 0, dm: 1 };

export function saveSubscription({ endpoint, userId, p256dh, auth, alertTypes, uaLabel }) {
  if (!endpoint || !userId || !p256dh || !auth) return false;
  const alerts = JSON.stringify({ ...DEFAULT_ALERTS, ...(alertTypes || {}) });
  db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, alert_types, ua_label, created_at)
      VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth,
      alert_types=excluded.alert_types, ua_label=excluded.ua_label`)
    .run(endpoint, userId, p256dh, auth, alerts, uaLabel || null);
  return true;
}

export function deleteSubscription(endpoint) {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
}

export function listSubscriptions(userId) {
  return db.prepare('SELECT endpoint, alert_types, ua_label, created_at, last_ok_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId);
}

export function updateAlerts(endpoint, userId, alertTypes) {
  const alerts = JSON.stringify({ ...DEFAULT_ALERTS, ...(alertTypes || {}) });
  return db.prepare('UPDATE push_subscriptions SET alert_types = ? WHERE endpoint = ? AND user_id = ?').run(alerts, endpoint, userId).changes > 0;
}

// ── Sending ─────────────────────────────────────────────────────────

// Send one payload to one stored subscription row. 404/410 → the device is
// gone or permission was revoked → delete the row (self-pruning).
async function sendTo(row, payload) {
  const wp = await lib();
  const keys = await vapidKeys();
  wp.setVapidDetails(subject(), keys.publicKey, keys.privateKey);
  try {
    await wp.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: 3600 },
    );
    db.prepare('UPDATE push_subscriptions SET last_ok_at = CURRENT_TIMESTAMP WHERE endpoint = ?').run(row.endpoint);
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) deleteSubscription(row.endpoint);
    else console.warn('[push] send failed:', e && (e.statusCode || e.message));
    return false;
  }
}

// Notify one user on all their devices, honouring per-type preferences.
// type ∈ {follow, reply, like, boost, dm, test}. Fire-and-forget at call sites.
export async function notifyUser(userId, { type, title, body, url }) {
  if (!(await pushReady())) return 0;
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  let sent = 0;
  for (const row of rows) {
    if (type !== 'test') {
      let alerts = DEFAULT_ALERTS;
      try { alerts = { ...DEFAULT_ALERTS, ...JSON.parse(row.alert_types || '{}') }; } catch { /* keep defaults */ }
      if (!alerts[type]) continue;
    }
    if (await sendTo(row, { type, title: String(title || '').slice(0, 120), body: String(body || '').slice(0, 240), url: url || '/' })) sent++;
  }
  return sent;
}

// Notify the owner of a site (the usual entry point from the S2S inbox).
export async function notifySite(slug, event) {
  const row = db.prepare('SELECT owner_id FROM sites WHERE slug = ?').get(slug);
  if (!row || !row.owner_id) return 0;
  return notifyUser(row.owner_id, event);
}

export default {
  publicKey, pushReady, DEFAULT_ALERTS,
  saveSubscription, deleteSubscription, listSubscriptions, updateAlerts,
  notifyUser, notifySite,
};
