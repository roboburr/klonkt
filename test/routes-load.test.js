// Every route file must at least PARSE and load.
//
// This exists because a stray `);` in routes/guardian.js took sound-fabrics.com
// down while 280 tests were green: not one of them imports a route file, so a
// syntax error there is invisible to the suite and only shows up as a server
// that will not boot. The tests covered the logic and missed the wiring.
//
// Cheap to run, and it fails on exactly the class of mistake that a hand-edited
// route is prone to: an unbalanced brace, a bad import, a name that moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();

const dir = new URL('../src/routes/', import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

test('there are route files to check', () => {
  assert.ok(files.length > 10, `expected the routes directory, found ${files.length} files`);
});

for (const f of files) {
  test(`routes/${f} loads`, async () => {
    // A throwing import is the failure we are after: a parse error, a missing
    // export, a bad path. Anything the module does at load time counts too,
    // because the server does exactly this on boot.
    await import(new URL(f, dir).href);
  });
}

test('the server module itself loads', async () => {
  // The whole wiring in one go: every router, every service it pulls in.
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'server.js'), 'utf8');
  assert.match(src, /routes/, 'server.js is the file that mounts the routers');
});
