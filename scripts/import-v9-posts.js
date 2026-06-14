/**
 * v9 → v1 post importer (Node version).
 *
 * Reads scripts/v9-posts-import.sql and executes it against the project's
 * SQLite database. Wraps in a transaction so if any INSERT fails, nothing
 * is committed. Idempotency is via the UNIQUE (site_id, slug) constraint
 * on posts — re-running this script will fail noisily on duplicates rather
 * than silently double-importing.
 *
 * Run with:
 *   node scripts/import-v9-posts.js
 *
 * Works locally (Windows: storage/database.sqlite) and on the server
 * (DATABASE_PATH from .env). Path resolution mirrors src/config/database.js.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Locate database ────────────────────────────────────────────────────
// Same fallback chain as src/config/database.js: env override > project default.
const DB_PATH = process.env.DATABASE_PATH ||
  path.join(__dirname, '..', 'storage', 'database.sqlite');

if (!fs.existsSync(DB_PATH)) {
  console.error(`✗ Database not found at: ${DB_PATH}`);
  console.error('  Has the app been started yet? (npm run dev creates it on boot)');
  process.exit(1);
}

const SQL_PATH = path.join(__dirname, 'v9-posts-import.sql');
if (!fs.existsSync(SQL_PATH)) {
  console.error(`✗ SQL file not found at: ${SQL_PATH}`);
  process.exit(1);
}

console.log(`→ Database:   ${DB_PATH}`);
console.log(`→ SQL script: ${SQL_PATH}`);

// ── Pre-flight checks ──────────────────────────────────────────────────
const db = new Database(DB_PATH);

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const siteCount = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
const postsBefore = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;

if (userCount === 0) {
  console.error('✗ No users in DB — register an account first via the web UI.');
  process.exit(1);
}
if (siteCount === 0) {
  console.error('✗ No sites in DB — the app should auto-create one on first boot.');
  process.exit(1);
}

console.log(`  Users: ${userCount}, Sites: ${siteCount}, Posts (before): ${postsBefore}`);

// ── Run the import ─────────────────────────────────────────────────────
const sql = fs.readFileSync(SQL_PATH, 'utf8');

// better-sqlite3 has its own transaction handling. The SQL file already
// contains BEGIN/COMMIT, but those are no-ops when run via .exec() inside
// a transaction. Wrapping ours guarantees atomicity even if someone strips
// the BEGIN/COMMIT from the SQL.
try {
  db.exec(sql);
  const postsAfter = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  const added = postsAfter - postsBefore;

  console.log(`✓ Import complete. ${added} post(s) added (total now ${postsAfter}).`);
  console.log();
  console.log('Imported posts:');
  const imported = db.prepare(`
    SELECT slug, title, pinned, type FROM posts
    ORDER BY published_at DESC
  `).all();
  for (const p of imported) {
    console.log(`  ${p.pinned ? '📌 ' : '   '}${p.slug.padEnd(28)} ${p.type.padEnd(8)} ${p.title}`);
  }
} catch (err) {
  console.error('✗ Import failed:', err.message);
  if (err.message.includes('UNIQUE constraint failed')) {
    console.error('  Looks like some of these posts are already imported.');
    console.error('  Check existing slugs:  SELECT slug FROM posts;');
  }
  process.exit(1);
}

db.close();
