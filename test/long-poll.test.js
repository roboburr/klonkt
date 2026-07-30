// Long-poll on news (Robins verzoek, 31-7): the thread in the app holds a
// request open; anything push-worthy wakes every waiter exactly once, and an
// unsubscribed waiter is never woken. The route wires this to 200/204.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

test('news wakes every waiter once, and only for that account', () => {
  let a = 0, b = 0, other = 0;
  AP.onNews('kid', () => a++);
  AP.onNews('kid', () => b++);
  AP.onNews('ander', () => other++);
  AP.wakeNews('kid');
  assert.equal(a, 1); assert.equal(b, 1);
  assert.equal(other, 0, 'someone else\'s news is not yours');
  AP.wakeNews('kid');
  assert.equal(a, 1, 'a waiter fires once; the app re-arms with a new request');
});

test('an unsubscribed waiter stays silent', () => {
  let fired = 0;
  const off = AP.onNews('kid', () => fired++);
  off();
  AP.wakeNews('kid');
  assert.equal(fired, 0);
});
