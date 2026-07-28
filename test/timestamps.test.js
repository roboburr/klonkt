// Every surface shows the same clock: the timezone from Beheer -> Instellingen.
// The Guardian PWA used to slice the raw UTC string, so a call for help sent at
// 20:20 Amsterdam time read 18:20 on the dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { formatDateTime } = await import('../src/middleware/render.js');
// Through the service, not straight into the table: settings are cached, so a
// raw INSERT would leave the running process on the old timezone.
const { setSetting } = await import('../src/services/SettingsService.js');
const setTz = (tz) => setSetting('timezone', tz);

test('an AP timestamp is shown in the site timezone, not in UTC', () => {
  setTz('Europe/Amsterdam');
  const s = formatDateTime('2026-07-28T18:20:33.000Z');   // summer: UTC+2
  assert.match(s, /20:20/, `expected 20:20 Amsterdam time, got "${s}"`);
});

test('the same moment in another timezone reads differently', () => {
  setTz('Pacific/Auckland');
  assert.match(formatDateTime('2026-07-28T18:20:33.000Z'), /06:20/);
  setTz('UTC');
  assert.match(formatDateTime('2026-07-28T18:20:33.000Z'), /18:20/);
});

test("a SQLite timestamp is UTC even though it does not say so", () => {
  // CURRENT_TIMESTAMP writes "2026-07-28 18:20:33". new Date() reads a string in
  // that shape as LOCAL time, which is only right while the server runs on UTC.
  setTz('Europe/Amsterdam');
  const stored = formatDateTime('2026-07-28 18:20:33');
  const explicit = formatDateTime('2026-07-28T18:20:33.000Z');
  assert.equal(stored, explicit, 'a stored timestamp must not depend on the machine timezone');
  assert.match(stored, /20:20/);
});

test('a missing or unparseable timestamp renders as nothing, never as Invalid Date', () => {
  assert.equal(formatDateTime(null), '');
  assert.equal(formatDateTime(''), '');
  assert.equal(formatDateTime('ooit'), '');
});

test('the Guardian PWA gets its timestamps pre-formatted', () => {
  // The dashboard builds its cards in the browser and has no timezone of its
  // own, so the server hands over when_text alongside the raw value.
  const src = fs.readFileSync(new URL('../src/routes/guardian.js', import.meta.url), 'utf8');
  assert.match(src, /when_text: formatDateTime\(h\.published \|\| h\.created_at\)/, 'help requests');
  assert.match(src, /when_text: formatDateTime\(p\.published \|\| p\.created_at\)/, "the wards' feed");
});
