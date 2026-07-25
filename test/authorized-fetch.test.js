// FEP-633c §5.3 note: a committed guardian is recognised for authorized fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');
// Commit a guardian relation: kid (ward) is guarded by mom.
const MOM = 'https://mom.example/ap/users/mom';
db.prepare("INSERT INTO ap_guardianships (slug, role, other_uri, status, created_at) VALUES ('kid','ward',?, 'accepted', CURRENT_TIMESTAMP)").run(MOM);

test('a committed guardian is recognised; a stranger is not', () => {
  assert.equal(AP.isWardGuardian('kid', MOM), true);
  assert.equal(AP.isWardGuardian('kid', 'https://x.example/ap/users/stranger'), false);
  assert.equal(AP.isWardGuardian('nosuch', MOM), false);
});
