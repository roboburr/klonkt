// One Ward, however you spell its address.
//
// Shaer never asks for a URL. You type a handle, and its `Handle` parser turns a
// bare host into `acct:<host>@<host>` — the WebFinger convention for "give me
// this server's primary actor". WebFinger here only ever looked the user part up
// as a site slug, so that resource 404'd and the app could not find a Ward it was
// pointed straight at.
//
// The emoji host makes the second half of the problem visible. Foundation's URL
// (and Node's, and every browser's) silently punycodes a host, so a pasted
// `https://🩵.is.wildenvrij.nl` arrives as `xn--zz9h.is.wildenvrij.nl` while a
// typed `🩵.is.wildenvrij.nl` arrives verbatim. Same Ward, two spellings, and a
// byte comparison says they are strangers.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
// `kid` is the primary site; `oma` is a second public site that must NOT be
// what a bare host resolves to.
// Explicit created_at: getPrimarySite() falls back to the OLDEST site, and two
// rows inserted in the same second would make that order a coin flip.
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary, created_at) VALUES (?,?,?,?,1,?)')
  .run('s1', 'kid', 'kid', 'u1', '2026-01-01 00:00:00');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary, created_at) VALUES (?,?,?,?,0,?)')
  .run('s2', 'oma', 'oma', 'u1', '2026-06-01 00:00:00');

const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const port = server.address().port;
test.after(() => server.close());

/// Ask WebFinger for a resource while the server believes it is served at `base`.
async function finger(resource, base = 'https://test.example') {
  const previous = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = base;
  try {
    const url = `http://127.0.0.1:${port}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;
    const res = await fetch(url);
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  } finally {
    process.env.PUBLIC_BASE_URL = previous;
  }
}

/// The `self` link is the actor the client will actually fetch next.
const actorOf = (body) => body.links.find((l) => l.rel === 'self').href;

test('a normal handle still resolves (the case that already worked)', async () => {
  const { status, body } = await finger('acct:oma@test.example');
  assert.equal(status, 200);
  assert.equal(actorOf(body), 'https://test.example/ap/users/oma', 'a named slug wins over the primary fallback');
});

test('a bare host resolves the primary actor', async () => {
  // The whole bug: this is what Shaer sends when you type `test.example`.
  const { status, body } = await finger('acct:test.example@test.example');
  assert.equal(status, 200, 'the bare host is a valid address, not a 404');
  assert.equal(actorOf(body), 'https://test.example/ap/users/kid', 'and it means the PRIMARY site, not just any site');
});

test('unicode and punycode spellings of one host find one Ward', async () => {
  const unicode = 'https://🩵.is.wildenvrij.nl';
  const punycode = 'https://xn--zz9h.is.wildenvrij.nl';

  const typed = await finger('acct:🩵.is.wildenvrij.nl@🩵.is.wildenvrij.nl', unicode);
  const pasted = await finger('acct:xn--zz9h.is.wildenvrij.nl@xn--zz9h.is.wildenvrij.nl', unicode);

  assert.equal(typed.status, 200, 'typed by hand: the emoji host');
  assert.equal(pasted.status, 200, 'pasted as a URL: the client already punycoded it');
  assert.deepEqual(actorOf(typed.body), actorOf(pasted.body), 'both spellings are the same Ward');

  // And it does not matter which spelling the server itself is configured with.
  const configuredAscii = await finger('acct:🩵.is.wildenvrij.nl@🩵.is.wildenvrij.nl', punycode);
  assert.equal(configuredAscii.status, 200, 'PUBLIC_BASE_URL may be written either way too');

  assert.equal(typed.body.subject, 'acct:kid@xn--zz9h.is.wildenvrij.nl',
    'the subject we answer with is the canonical one, never the alias that was asked for');
});

test('a bare host resolves even when no site carries the primary flag', async () => {
  // This is the state a fresh instance is actually in: is_primary defaults to 0
  // and the backfill only runs when the column is first added, so a site created
  // afterwards leaves the instance with no primary at all. The HTML side coped
  // (getPrimarySite falls back to the oldest) while this route kept its own
  // is_primary-only lookup — so / served the site and WebFinger said 404.
  db.prepare('UPDATE sites SET is_primary = 0').run();
  try {
    const { status, body } = await finger('acct:test.example@test.example');
    assert.equal(status, 200, 'an unflagged instance is still discoverable');
    assert.equal(actorOf(body), 'https://test.example/ap/users/kid', 'falls back to the oldest site');
  } finally {
    db.prepare('UPDATE sites SET is_primary = 1 WHERE id = ?').run('s1');
  }
});

test('an unknown user is still a 404', async () => {
  // The fallback must not turn every miss into the primary actor, or a typo
  // silently connects a child to the wrong account.
  const { status } = await finger('acct:nobody@test.example');
  assert.equal(status, 404);
});

test('a bare host that is not ours is still a 404', async () => {
  const { status } = await finger('acct:elders.example@elders.example');
  assert.equal(status, 404, 'we only answer for the host we are actually serving');
});

test('a malformed resource is a 400', async () => {
  const { status } = await finger('https://test.example/ap/users/kid');
  assert.equal(status, 400);
});
