// Web Push slice 1: VAPID key management + the subscription store. Actual
// delivery needs a real push service, so tests cover the pure parts: key
// auto-generation/persistence (no env editing) and the subscription CRUD with
// per-type alert preferences. Own process (node --test), so env tweaks here
// don't leak into other test files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushkey-'));
process.env.DATABASE_PATH = path.join(dir, 'database.sqlite');

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const Push = (await import('../src/services/PushService.js')).default;
const keyFile = path.join(dir, '.vapid');

test('VAPID keys auto-generate to a 0600 file and persist', async () => {
  const pub = await Push.publicKey();
  assert.ok(pub && typeof pub === 'string' && pub.length > 20, 'public key exists');
  assert.ok(fs.existsSync(keyFile), 'key file written next to the database');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'key file is 0600');
  }
  const onDisk = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  assert.equal(onDisk.publicKey, pub, 'served key matches the persisted one');
  assert.equal(await Push.pushReady(), true);
});

test('subscription store: save, list, update alerts, delete', () => {
  const ok = Push.saveSubscription({
    endpoint: 'https://push.example/ep1', userId: 'u1',
    p256dh: 'PK', auth: 'AUTH', uaLabel: 'Firefox op laptop',
  });
  assert.equal(ok, true);
  const list = Push.listSubscriptions('u1');
  assert.equal(list.length, 1);
  const alerts = JSON.parse(list[0].alert_types);
  assert.equal(alerts.follow, 1);   // defaults applied
  assert.equal(alerts.like, 0);
  // update preferences
  assert.equal(Push.updateAlerts('https://push.example/ep1', 'u1', { like: 1, follow: 0 }), true);
  const upd = JSON.parse(Push.listSubscriptions('u1')[0].alert_types);
  assert.equal(upd.like, 1);
  assert.equal(upd.follow, 0);
  assert.equal(upd.dm, 1);          // untouched default survives
  // wrong user can't update
  assert.equal(Push.updateAlerts('https://push.example/ep1', 'u2', { like: 0 }), false);
  // delete
  assert.equal(Push.deleteSubscription('https://push.example/ep1'), true);
  assert.equal(Push.listSubscriptions('u1').length, 0);
});

test('re-subscribing the same endpoint upserts instead of duplicating', () => {
  Push.saveSubscription({ endpoint: 'https://push.example/ep2', userId: 'u1', p256dh: 'A', auth: 'B' });
  Push.saveSubscription({ endpoint: 'https://push.example/ep2', userId: 'u1', p256dh: 'C', auth: 'D' });
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').all('https://push.example/ep2');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].p256dh, 'C');
});

test('burst throttle: one ping per window per (user,type); test type never throttles', () => {
  assert.equal(Push.throttled('tu1', 'like', 1000), false);   // first passes
  assert.equal(Push.throttled('tu1', 'like', 1100), true);    // within 300s window
  assert.equal(Push.throttled('tu1', 'like', 1301), false);   // window elapsed
  assert.equal(Push.throttled('tu1', 'boost', 1000), false);  // other type independent
  assert.equal(Push.throttled('tu2', 'like', 1000), false);   // other user independent
  assert.equal(Push.throttled('tu1', 'test', 1000), false);   // test bypasses
  assert.equal(Push.throttled('tu1', 'test', 1001), false);
});

test('incomplete subscription payloads are refused', () => {
  assert.equal(Push.saveSubscription({ endpoint: '', userId: 'u1', p256dh: 'x', auth: 'y' }), false);
  assert.equal(Push.saveSubscription({ endpoint: 'https://e', userId: 'u1', p256dh: '', auth: 'y' }), false);
});
