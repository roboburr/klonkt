// shaer-ipb: ap_interactions.acted_* was de DERDE bron van "heb ik hierop
// gereageerd", naast ap_timeline.liked/boosted en ap_my_reactions. shaer-9e9
// trok de eerste twee samen en liet deze staan, omdat hij op het interactie-rij-
// id gesleuteld was en de tussentabel op de object-URI.
//
// Nu is ook deze bron de tussentabel. Wat hier bewaakt wordt:
//   - de migratie neemt bestaande acted_*-rijen mee
//   - getInteractions leest uit de tussentabel, niet meer uit de kolom
//   - dezelfde note die je als comment EN als post kent, is EEN feit
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');
db.prepare('INSERT INTO posts (id, site_id, slug, author_id, title, content, status) VALUES (?,?,?,?,?,?,?)')
  .run('p1', 's1', 'mijn-post', 'u1', 'Mijn post', '<p>x</p>', 'published');

const site = { slug: 'me', title: 'Me' };
const COMMENT = 'https://203.0.113.60/notes/comment-1';
const COMMENT2 = 'https://203.0.113.60/notes/comment-2';

function comment(uri, extra = {}) {
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, content, acted_like, acted_boost)
              VALUES ('reply', 'p1', ?, ?, 'Anna', '@anna@203.0.113.60', '<p>hoi</p>', ?, ?)`)
    .run(uri, 'https://203.0.113.60/users/anna', extra.like ? 1 : 0, extra.boost ? 1 : 0);
  return db.prepare('SELECT id FROM ap_interactions WHERE object_uri = ?').get(uri).id;
}

const knop = (uri) => {
  const plat = [];
  const loop = (ns) => ns.forEach((n) => { plat.push(n); loop(n.children || []); });
  loop(AP.getInteractions('p1', 'https://klonkt.test', site).thread);
  const n = plat.find((x) => x.noteId === uri);
  assert.ok(n, `node ${uri} hoort in de thread te staan`);
  return { like: n.acted_like, boost: n.acted_boost };
};

test('de migratie neemt acted_* mee naar de tussentabel', () => {
  comment(COMMENT, { like: true });
  const uit = AP.migrateReactions({ force: true });
  assert.equal(uit.reacties, 1, 'één reactie hoort overgenomen te worden');
  assert.deepEqual(AP.getReaction('me', COMMENT), { liked: true, boosted: false });
});

test('en is idempotent: nog een keer draaien voegt niets toe', () => {
  const uit = AP.migrateReactions({ force: true });
  assert.equal(uit.reacties, 0);
});

test('de knopstand komt uit de tussentabel, niet uit de kolom', () => {
  // Zet de kolom en de tussentabel EXPLICIET tegenover elkaar. Zou de view nog
  // uit de kolom lezen, dan zou hier true uit komen.
  db.prepare('UPDATE ap_interactions SET acted_boost = 1 WHERE object_uri = ?').run(COMMENT);
  assert.equal(knop(COMMENT).boost, false, 'de kolom liegt en wordt genegeerd');
  AP.setReaction('me', COMMENT, 'boost', true);
  assert.equal(knop(COMMENT).boost, true);
});

test('een reactie geven en intrekken laat niets achter', () => {
  comment(COMMENT2);
  assert.deepEqual(knop(COMMENT2), { like: false, boost: false });
  AP.setReaction('me', COMMENT2, 'like', true);
  assert.equal(knop(COMMENT2).like, true);
  AP.setReaction('me', COMMENT2, 'like', false);
  assert.equal(knop(COMMENT2).like, false);
});

test('dezelfde note als comment en als post is EEN feit', () => {
  // De betekeniswijziging van deze bead, expliciet vastgelegd: like je een note
  // in je Krant, dan staat de knop onder diezelfde note als comment ook aan.
  // Twee knoppen die los van elkaar aan konden staan voor hetzelfde object was
  // eerder een bug dan een feature -- er gaat immers één Like de fediverse in.
  const BEIDE = 'https://203.0.113.60/notes/overlap';
  comment(BEIDE);
  db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, content, created_at)
              VALUES (?,?,?,?,?,?)`).run(BEIDE, 'me', 'https://203.0.113.60/users/anna', 'Anna', '<p>x</p>', '2026-08-06 09:00:00');
  AP.setReaction('me', BEIDE, 'like', true);
  assert.equal(knop(BEIDE).like, true, 'de like uit de Krant hoort onder de comment te staan');
});

test('een reactie zonder object_uri blokkeert de migratie niet', () => {
  // Een like of announce draagt geen object_uri, en fedi-react eist er een --
  // zulke rijen kunnen dus nooit acted_* dragen. De migratie moet ze overslaan
  // in plaats van erover te struikelen. De kolom is NOT NULL, dus zo'n rij draagt
  // een lege string; zo staat hij ook op beta.
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, acted_like)
              VALUES ('like', 'p1', '', ?, 'Bob', 1)`).run('https://203.0.113.60/users/bob');
  const uit = AP.migrateReactions({ force: true });
  assert.equal(uit.reacties, 0, 'niets over te nemen, en geen fout');
});
