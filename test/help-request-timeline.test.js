// A 🛟 help request (FEP-633c 5.2.1) is a message, not a post: it belongs in
// Berichten and the Guardian PWA, never in de Krant. It used to land in both,
// because the timeline insert only asked "top-level post from someone I follow"
// and never looked at who the note was addressed to.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

const PUB = 'https://www.w3.org/ns/activitystreams#Public';
const WARD = 'https://ward.test/ap/users/kid';
const note = (extra) => ({ id: 'https://ward.test/notes/1', type: 'Note', content: '<p>hoi</p>', ...extra });

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'guard', 'Guard', 'u1', 1);

test('a public post from someone we follow belongs in the timeline', () => {
  assert.equal(AP.belongsInTimeline(note({ to: [PUB], cc: [`${WARD}/followers`] })), true);
});

test('a followers-only post still belongs there: you follow them', () => {
  assert.equal(AP.belongsInTimeline(note({ to: [`${WARD}/followers`] })), true);
});

test('a direct note does not, whoever sent it', () => {
  const dm = note({ to: ['https://test.example/ap/users/guard'] });
  assert.equal(AP.noteVisibility(dm), 'direct');
  assert.equal(AP.belongsInTimeline(dm), false, 'a DM is a message, not a feed post');
});

test('a help request is direct by construction, so it is refused too', () => {
  const help = note({ to: ['https://test.example/ap/users/guard'], 'shaer:helpRequest': true });
  assert.equal(AP.belongsInTimeline(help), false);
});

test('a reply never belongs in the timeline either: it belongs to its thread', () => {
  assert.equal(AP.belongsInTimeline(note({ to: [PUB], inReplyTo: 'https://x.test/notes/9' })), false);
});

test('the self-heal drops a help request that was already cached as a post', async () => {
  // Two rows with an identical shape; only the mention marks one as a 🛟.
  for (const id of ['https://ward.test/notes/help', 'https://ward.test/notes/post']) {
    db.prepare('INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES (?,?,?,?)').run(id, 'guard', WARD, '<p>x</p>');
  }
  db.prepare('INSERT INTO ap_mentions (slug, object_uri, actor_uri, content, help_request) VALUES (?,?,?,?,1)')
    .run('guard', 'https://ward.test/notes/help', WARD, '<p>x</p>');
  // A public mention from someone you follow IS a post and must survive.
  db.prepare('INSERT INTO ap_mentions (slug, object_uri, actor_uri, content, help_request) VALUES (?,?,?,?,0)')
    .run('guard', 'https://ward.test/notes/post', WARD, '<p>x</p>');

  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('selfheal_version', '0')").run();
  await AP.selfHealTimeline();

  const left = db.prepare('SELECT id FROM ap_timeline WHERE slug = ?').all('guard').map((r) => r.id);
  assert.ok(!left.includes('https://ward.test/notes/help'), 'the 🛟 is gone from the Krant');
  assert.ok(left.includes('https://ward.test/notes/post'), 'the ordinary mention stays');
});

test('and it is still there for Berichten and the Guardian PWA', () => {
  const help = db.prepare('SELECT * FROM ap_mentions WHERE object_uri = ?').get('https://ward.test/notes/help');
  assert.ok(help, 'the mention row is untouched');
  assert.equal(help.help_request, 1);
  assert.ok(AP.getNotifications('guard', 20).some((n) => n.type === 'mention'), 'it shows up in Berichten');
});
