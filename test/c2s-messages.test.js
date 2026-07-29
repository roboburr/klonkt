// What the app reads is what the app can show.
//
// Shaer builds Berichten, gesprekken and the help-escalation list from one
// source: the C2S inbox read. That read served only the timeline, and a direct
// note (a DM, a guardian's wave, a ward's 🛟) is not in the timeline, because a
// note addressed to named people is a message and not a post.
//
// The result was an app that showed your own replies and nothing that was said
// to you. These tests hold the two tables apart in the database and together in
// the read.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');

const mention = (uri, { wave = 0, help = 0, content = '<p>hoi</p>', published = null } = {}) =>
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, actor_handle, content, published, wave, help_request)
              VALUES ('kid', ?, 'https://oma.test/u/oma', 'Oma', '@oma@oma.test', ?, ?, ?, ?)`)
    .run(uri, content, published, wave, help);

mention('https://oma.test/n/1', { wave: 1, content: '<p><a href="x">@kid@test.example</a> 👋</p>' });
mention('https://oma.test/n/2', { help: 1 });
mention('https://oma.test/n/3');
// A public mention from someone you follow is stored in BOTH tables. It is a
// post, and it must not turn up twice.
mention('https://vriend.test/n/9');
db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES (?, 'kid', 'https://vriend.test/u/v', '<p>publiek</p>')`)
  .run('https://vriend.test/n/9');

test('a direct note is not a timeline row', () => {
  // The premise. If this ever flips, the app gets its messages back by
  // accident and the Krant fills up with DMs again (d9ad6c5).
  assert.equal(AP.getTimeline('kid', 50).length, 1, 'only the public post is a post');
});

test('the direct notes come out of the message read', () => {
  const msgs = AP.getDirectMessages('kid', 60);
  const ids = msgs.map((m) => m.object_uri).sort();
  assert.deepEqual(ids, ['https://oma.test/n/1', 'https://oma.test/n/2', 'https://oma.test/n/3'],
    'the three messages, and NOT the note that is already a post');
  assert.equal(msgs.find((m) => m.object_uri.endsWith('/1')).wave, 1, 'the wave is marked as one');
  assert.equal(msgs.find((m) => m.object_uri.endsWith('/2')).help_request, 1, 'and the buoy as a buoy');
});

test('a stored stamp becomes an instant, not a two-hour lie', () => {
  // SQLite writes CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' in UTC, which
  // Date.parse reads as local time. On this server that is off by an hour or
  // two, which is enough to scramble the order of a conversation.
  assert.equal(AP.isoStamp('2026-07-29 08:15:00'), '2026-07-29T08:15:00Z');
  assert.equal(AP.isoStamp('2026-07-29T08:15:00.000Z'), '2026-07-29T08:15:00.000Z');
  assert.equal(AP.isoStamp(null), undefined);
  assert.equal(AP.isoStamp('nonsense'), undefined);
});

test('the inbox read serves posts and messages in one collection', async (t) => {
  // Straight through the route, because the mapping is where the app-facing
  // shape is decided: the addressing that turns a note into a conversation and
  // the flag that turns one into a wave.
  const crypto = await import('crypto');
  const express = (await import('express')).default;
  const routes = (await import('../src/routes/activitypub.js')).default;

  const bearer = 'test-token-' + 'a'.repeat(24);
  const hash = crypto.createHash('sha256').update(bearer).digest('base64url');
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(hash, 'test-client', 'u1', 'kid', 'read write');

  const app = express();
  app.use(routes);
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/ap/users/kid/inbox`;
  const doc = await (await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } })).json();

  const byId = Object.fromEntries(doc.orderedItems.map((i) => [i.object.id, i.object]));
  assert.equal(doc.orderedItems.length, 4, 'one post and three messages, the double counted once');

  const wave = byId['https://oma.test/n/1'];
  assert.ok(wave, 'the wave is in the read at all (this is the whole bug)');
  assert.equal(wave['shaer:wave'], true, 'and it says it is a wave');
  assert.deepEqual(wave.to, ['https://test.example/ap/users/kid'],
    'addressed to me, which is what makes it a conversation instead of a loose note');
  assert.ok((wave.tag || []).some((x) => x.type === 'Mention' && x.href === 'https://test.example/ap/users/kid'),
    'with a Mention the client recognises itself in');
  assert.equal(wave['shaer:author'].name, 'Oma', 'and a byline to show');
  assert.ok(!/@kid@test\.example/.test(wave.content), 'the leading @mention is stripped, like Berichten on the web');

  assert.equal(byId['https://oma.test/n/2']['shaer:helpRequest'], true, 'the buoy stays a buoy');
  assert.equal(byId['https://oma.test/n/3']['shaer:wave'], undefined, 'an ordinary DM claims to be neither');
  assert.equal(byId['https://vriend.test/n/9']['shaer:wave'], undefined, 'and the public post is served once, as a post');
});
