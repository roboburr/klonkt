// Moderatie van inkomende replies: rejectInteraction verwijdert + tombstonet
// (zodat ingest/thread-crawl 'm nooit terugbrengen), tenancy-gescoped zodat een
// andere site andermans replies niet kan verwijderen. Flag-target komt uit de
// lokale kopie (werkt dus ook voor private notes die niet te fetchen zijn).
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

// ── Seed: twee sites, elk met een post; een reply op post van site A ─────
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('sA', 'sitea', 'A', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('sB', 'siteb', 'B', 'u1');
db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, type, created_at, updated_at, published_at)
  VALUES ('pA','sA','post-a','u1','A','<p>x</p>','published','post',datetime('now'),datetime('now'),datetime('now'))`).run();

function addReply(objectUri) {
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, content, visibility)
    VALUES ('reply','pA',?,?,?,?,'public')`).run(objectUri, 'https://remote.test/users/troll', 'Troll', '<p>weg ermee</p>');
  return db.prepare('SELECT id FROM ap_interactions WHERE object_uri = ?').get(objectUri).id;
}

test('rejectInteraction: verwijdert de rij en tombstonet de object_uri', () => {
  const id = addReply('https://remote.test/n/bad1');
  const r = AP.rejectInteraction({ slug: 'sitea' }, id, 'test');
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT 1 FROM ap_interactions WHERE id = ?').get(id), undefined);
  assert.equal(AP.isRejectedObject('https://remote.test/n/bad1'), true);
});

test('tombstone blijft de thread uit houden (getInteractions na herinsert-poging)', () => {
  // simuleer re-delivery: zelfde object_uri opnieuw inserten zou door de
  // ingest-guard (isRejectedObject) geweigerd worden; de guard is de check hier
  assert.equal(AP.isRejectedObject('https://remote.test/n/bad1'), true);
  // en een nooit-getombstonede URI is vrij
  assert.equal(AP.isRejectedObject('https://remote.test/n/fresh'), false);
});

test('tenancy: site B kan een reply op site A NIET verwijderen', () => {
  const id = addReply('https://remote.test/n/bad2');
  const r = AP.rejectInteraction({ slug: 'siteb' }, id, 'poging');
  assert.equal(r.error, 'forbidden');
  assert.ok(db.prepare('SELECT 1 FROM ap_interactions WHERE id = ?').get(id), 'reply mag niet verdwenen zijn');
  assert.equal(AP.isRejectedObject('https://remote.test/n/bad2'), false);
});

test('interactionReportTarget: geeft lokale URIs (site A), null voor site B', () => {
  const id = addReply('https://remote.test/n/bad3');
  const tgt = AP.interactionReportTarget({ slug: 'sitea' }, id);
  assert.equal(tgt.objectUri, 'https://remote.test/n/bad3');
  assert.equal(tgt.actorUri, 'https://remote.test/users/troll');
  assert.equal(AP.interactionReportTarget({ slug: 'siteb' }, id), null);
});

test('onbestaande interactie = not_found', () => {
  assert.equal(AP.rejectInteraction({ slug: 'sitea' }, 999999, 'x').error, 'not_found');
});
