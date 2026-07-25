// FEP-633c §2.2: shaer:hasGuardians object hint (outbound stamp + register).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const G = await import('../src/services/guardianship/index.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1','u1','u1@t','x','god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1','kid','kid','u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,0)').run('s2','free','free','u1');
db.prepare("INSERT INTO ap_guardianships (slug, role, other_uri, status, created_at) VALUES ('kid','ward','https://m.example/mom','accepted',CURRENT_TIMESTAMP)").run();

test('a ward stamps the hint; a free actor does not', () => {
  assert.deepEqual(G.hasGuardiansProps('kid'), { 'shaer:hasGuardians': true });
  assert.deepEqual(G.hasGuardiansProps('free'), {});
});

test('objectHasGuardians reads the hint, register-only', () => {
  assert.equal(G.objectHasGuardians({ 'shaer:hasGuardians': true }), true);
  assert.equal(G.objectHasGuardians({}), false);
});
