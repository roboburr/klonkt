// Paid posts: the encryption key auto-generates (no env needed). This file runs
// in its own process (node --test), so deleting PAID_SECRET here doesn't affect
// the other paid tests, which set it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

delete process.env.PAID_SECRET;                         // force the file path
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paidkey-'));
process.env.DATABASE_PATH = path.join(dir, 'database.sqlite');

const { encrypt, decrypt, cryptoBoxReady } = await import('../src/services/CryptoBox.js');
const keyFile = path.join(dir, '.paid-secret');

test('without PAID_SECRET, a key file is generated and the box is ready', () => {
  assert.equal(cryptoBoxReady(), true);
  assert.ok(fs.existsSync(keyFile), 'key file was written next to the database');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, 'key file is 0600');
  }
});

test('encrypt/decrypt roundtrips with the generated key', () => {
  const enc = encrypt('patreon-creator-token');
  assert.notEqual(enc, 'patreon-creator-token');
  assert.equal(decrypt(enc), 'patreon-creator-token');
});

test('the generated key persists (a second read reuses the same file)', () => {
  const first = fs.readFileSync(keyFile, 'utf8');
  assert.ok(first.length >= 16);
  // Encrypt now, and decrypting still works: the same persisted key is used.
  const enc = encrypt('x');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), first, 'key file unchanged');
  assert.equal(decrypt(enc), 'x');
});
