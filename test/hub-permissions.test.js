// Unit-tests voor de hub-permissielaag — juist `canAdminSite` was lang stil kapot
// (las een nooit-gevulde user.siteRoles), dus dit dekt 'm nu af. Draait op de
// ingebouwde node:test (geen extra deps). In-memory SQLite → raakt geen echte data.
//
// Run: npm test   (= node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Isoleer van de echte DB: ':memory:' MOET gezet zijn vóór de eerste import van
// config/database.js (die maakt de singleton-connectie op basis van deze env).
process.env.DATABASE_PATH = ':memory:';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
const PermissionsService = (await import('../src/services/PermissionsService.js')).default;
const { getPrimarySite } = await import('../src/middleware/site.js');

dbMod.initializeDatabase();

// ── Seed ────────────────────────────────────────────────────────────────
function addUser(id, role) {
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, id, id + '@test', 'x', role);
}
function addSite(id, slug, ownerId, isPrimary = 0) {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)')
    .run(id, slug, slug, ownerId, isPrimary);
}
addUser('u-god', 'god');
addUser('u-owner', 'member');
addUser('u-collab', 'member');
addUser('u-stranger', 'member');
addSite('s1', 'site-een', 'u-owner', 1);

const god      = { id: 'u-god', role: 'god' };
const owner    = { id: 'u-owner', role: 'member' };
const collab   = { id: 'u-collab', role: 'member' };
const stranger = { id: 'u-stranger', role: 'member' };
const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');

// ── canAdminSite ─────────────────────────────────────────────────────────
test('canAdminSite: god mag altijd', () => {
  assert.equal(PermissionsService.canAdminSite(god, site()), true);
});
test('canAdminSite: owner mag', () => {
  assert.equal(PermissionsService.canAdminSite(owner, site()), true);
});
test('canAdminSite: vreemde zonder membership mag niet', () => {
  assert.equal(PermissionsService.canAdminSite(stranger, site()), false);
});
test('canAdminSite: collaborator zonder membership mag niet', () => {
  assert.equal(PermissionsService.canAdminSite(collab, site()), false);
});
test('canAdminSite: collaborator MET site_members-admin mag (de gefixte dode code)', () => {
  db.prepare("INSERT OR REPLACE INTO site_members (site_id, user_id, role) VALUES ('s1','u-collab','admin')").run();
  assert.equal(PermissionsService.canAdminSite(collab, site()), true);
});
test('canAdminSite: site_members met rol "member" (geen admin) mag niet', () => {
  db.prepare("INSERT OR REPLACE INTO site_members (site_id, user_id, role) VALUES ('s1','u-stranger','member')").run();
  assert.equal(PermissionsService.canAdminSite(stranger, site()), false);
});
test('canAdminSite: null user of null site → false (geen crash)', () => {
  assert.equal(PermissionsService.canAdminSite(null, site()), false);
  assert.equal(PermissionsService.canAdminSite(owner, null), false);
});

// ── Delegatie: canEditPost via canAdminSite ──────────────────────────────
test('canEditPost: collaborator-admin kan een post van een ander bewerken (via canAdminSite)', () => {
  const post = { author_id: 'iemand-anders' };
  assert.equal(PermissionsService.canEditPost(collab, post, site()), true);
});
test('canEditPost: vreemde kan een post van een ander NIET bewerken', () => {
  const post = { author_id: 'iemand-anders' };
  assert.equal(PermissionsService.canEditPost(stranger, post, site()), false);
});

// ── getPrimarySite (#3) ──────────────────────────────────────────────────
test('getPrimarySite: geeft de is_primary-site', () => {
  assert.equal(getPrimarySite().id, 's1');
});
test('getPrimarySite: valt terug op de oudste als geen is_primary gemarkeerd is', () => {
  db.prepare('UPDATE sites SET is_primary = 0').run();
  assert.equal(getPrimarySite().id, 's1'); // s1 is de oudste/enige
  db.prepare("UPDATE sites SET is_primary = 1 WHERE id = 's1'").run(); // herstel
});
