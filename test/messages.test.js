// Messages-centrum: getMessages voegt notificaties + eigen outbound replies samen
// in één stroom, groepeert opeenvolgende likes/boosts op dezelfde post, en geeft
// visibility door (voor de privé-badge). Besluit Robin+Bart 2026-07-16.
//
// Run: npm test   (= node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
const AP = await import('../src/services/ActivityPubService.js');

dbMod.initializeDatabase();

// ── Seed: site + post + interacties + eigen reply ────────────────────────
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');
db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, created_at, updated_at, published_at)
  VALUES ('p1','s1','mijn-post','u1','Mijn post','<p>x</p>','published','post',datetime('now'),datetime('now'),datetime('now'))`).run();

function addInter(kind, actor, createdAt, extra = {}) {
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_icon, content, visibility, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kind, 'p1', extra.object_uri || '', 'https://r.test/u/' + actor, actor, extra.icon || null,
         extra.content || null, extra.visibility || 'public', createdAt);
}
// drie likes kort na elkaar (zelfde post) → moeten groeperen tot één item
addInter('like', 'Anna', '2026-07-18 10:00:00');
addInter('like', 'Ben',  '2026-07-18 10:01:00');
addInter('like', 'Cas',  '2026-07-18 10:02:00');
// een privé-reply (direct) ertussen, later
addInter('reply', 'Dana', '2026-07-18 11:00:00', { object_uri: 'https://r.test/n/1', content: '<p>psst geheim</p>', visibility: 'direct' });
// eigen outbound reply, nog later
db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, to_handle, content, created_at)
  VALUES ('out1','me','p1','mijn-post','https://r.test/n/1','https://r.test/u/Dana','@dana@r.test','<p>mijn antwoord</p>','2026-07-18 12:00:00')`).run();

const msgs = AP.getMessages('me', 50);

test('eigen outbound reply zit als "sent" in de stroom (nieuwste eerst)', () => {
  const sent = msgs.find((m) => m.type === 'sent');
  assert.ok(sent, 'sent-item ontbreekt');
  assert.equal(sent.outboxId, 'out1');
  assert.equal(sent.to_handle, '@dana@r.test');
  assert.equal(msgs[0].type, 'sent', 'nieuwste item hoort bovenaan');
});

test('opeenvolgende likes op dezelfde post groeperen tot één item met count', () => {
  const likes = msgs.filter((m) => m.type === 'like');
  assert.equal(likes.length, 1, 'likes horen gegroepeerd te zijn');
  assert.equal(likes[0].count, 3);
  assert.equal(likes[0].actors.length, 3);
});

test('privé-reply draagt visibility voor de badge en heeft post-context', () => {
  const reply = msgs.find((m) => m.type === 'reply');
  assert.equal(reply.visibility, 'direct');
  assert.equal(reply.post_slug, 'mijn-post');
  assert.equal(reply.post_title, 'Mijn post');
});

test('notificationsSeenAt: 0 zonder watermark, daarna > 0', () => {
  assert.equal(AP.notificationsSeenAt('me'), 0);
  AP.markNotificationsSeen('me');
  assert.ok(AP.notificationsSeenAt('me') > 0);
});
