import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../../storage/database.sqlite');

// Ensure storage directory exists
const storageDir = path.dirname(dbPath);
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

// Initialize database
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initializeDatabase() {
  const tableExists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' AND name='users'
  `).get();

  if (!tableExists) {
    console.log('🔧 Initializing database schema...');
    const schemaPath = path.join(__dirname, '..', 'db', 'migrations', '001-init.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    db.exec(schema);
    console.log('✅ Database initialized with v9-soul schema');
  }

  // Additive column migrations — safe to run every boot.
  // SQLite throws if the column already exists; we swallow that.
  ensureColumn('sites', 'enable_audio_player', 'INTEGER DEFAULT 1');
  ensureColumn('sites', 'profile_photo', 'TEXT');
  ensureColumn('audio_tracks', 'cover_url', 'TEXT');
  ensureColumn('audio_tracks', 'album', 'TEXT');
  ensureColumn('users', 'reset_token', 'TEXT');
  ensureColumn('users', 'reset_token_expires', 'DATETIME');
  // Google OAuth: koppel een Google-account aan een user (login via Google).
  ensureColumn('users', 'google_sub', 'TEXT');
  // Site-level moderation toggle. 'trust' = auto-approve, 'moderate' = pending until reviewed.
  ensureColumn('sites', 'comments_moderation_mode', "TEXT DEFAULT 'trust'");
  // Per-site Prutter toggle: when off, DM endpoints/UI are hidden for that site.
  ensureColumn('sites', 'enable_prutter', 'INTEGER DEFAULT 1');

  // v9 audit additions —————————————————————————————————————————
  // SEO/social columns the v9 template uses (most live in 001-init.sql already
  // for fresh DBs but ensureColumn is idempotent for existing DBs).
  ensureColumn('sites', 'twitter',         'TEXT');     // @handle (with @)
  ensureColumn('sites', 'schema_type',     "TEXT DEFAULT 'Person'"); // Person|Organization
  ensureColumn('sites', 'publisher_name',  'TEXT');
  ensureColumn('sites', 'publisher_url',   'TEXT');
  ensureColumn('sites', 'publisher_logo',  'TEXT');
  ensureColumn('sites', 'profile_enabled', 'INTEGER DEFAULT 1');
  ensureColumn('sites', 'profile_name',    'TEXT');     // display name (falls back to title)
  ensureColumn('sites', 'profile_bio',     'TEXT');     // short bio for header
  ensureColumn('sites', 'profile_links',   'TEXT');     // JSON array [{platform, url}]
  ensureColumn('sites', 'feed_view_default', "TEXT DEFAULT 'timeline'"); // timeline | grid
  ensureColumn('sites', 'feed_view_switch',  'INTEGER DEFAULT 1');       // show switcher
  ensureColumn('sites', 'show_search',     'INTEGER DEFAULT 1');
  ensureColumn('sites', 'show_archive_link', 'INTEGER DEFAULT 1');

  // Per-post noindex + type
  ensureColumn('posts', 'noindex', 'INTEGER DEFAULT 0');
  ensureColumn('posts', 'type',    "TEXT DEFAULT 'post'");  // post | foto | video | audio

  // Playlists (v9 feature) — first-class entity. CREATE IF NOT EXISTS is
  // idempotent so it's safe to run on every boot regardless of DB age.
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      year INTEGER,
      cover_url TEXT,
      kind TEXT DEFAULT 'album',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (site_id) REFERENCES sites(id)
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (playlist_id, track_id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES audio_tracks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pos
      ON playlist_tracks(playlist_id, position);
  `);

  // Globale app-instellingen (key/value singleton). O.a. de tenancy-modus
  // (solo = één site, hub = bedrijfssite + /user/). Default = solo.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('tenancy', 'solo')").run();
}

function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`🔧 Added column ${table}.${column}`);
  } catch (e) {
    // "duplicate column name" → already there. Anything else, surface it.
    if (!/duplicate column/i.test(e.message)) {
      console.error(`❌ ensureColumn(${table}.${column}):`, e.message);
    }
  }
}

export default db;
