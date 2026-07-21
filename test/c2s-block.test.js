// C2S Block / Undo(Block): Shaer "in Orbit" is a real server-side block.
// The activity lands in ap_blocks (the Block tab) via the same blockTarget
// the web UI uses; Undo(Block) releases it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,?)').run('s1', 'me', 'Me', 'u1', 1);
const site = db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');
const user = { id: 'u1', username: 'u1' };

const BULLY = 'https://r.test/u/bully';

test('C2S Block lands in ap_blocks (the Block tab)', async () => {
  const out = await AP.ingestOutboxActivity(site, user, { type: 'Block', object: BULLY });
  assert.equal(out.status, 202);
  assert.equal(out.url, BULLY);
  const rows = AP.listBlocks('me');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, BULLY);
  assert.equal(rows[0].kind, 'actor');
});

test('C2S Undo(Block) releases it again', async () => {
  const out = await AP.ingestOutboxActivity(site, user, {
    type: 'Undo',
    object: { type: 'Block', object: BULLY },
  });
  assert.equal(out.status, 202);
  assert.equal(AP.listBlocks('me').length, 0);
});

test('Block without an object is a clean 400', async () => {
  const out = await AP.ingestOutboxActivity(site, user, { type: 'Block' });
  assert.equal(out.status, 400);
});
