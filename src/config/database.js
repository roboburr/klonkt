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
  // Read-only/kijk-account: kan alles bekijken maar geen wijzigingen doen.
  ensureColumn('users', 'readonly', 'INTEGER DEFAULT 0');
  // Site-level moderation toggle. 'trust' = auto-approve, 'moderate' = pending until reviewed.
  ensureColumn('sites', 'comments_moderation_mode', "TEXT DEFAULT 'moderate'");
  // Per-site Prutter toggle: when off, DM endpoints/UI are hidden for that site.
  ensureColumn('sites', 'enable_prutter', 'INTEGER DEFAULT 1');
  // Cirkels: mag deze site in cirkels van anderen verschijnen (surfacing opt-out).
  ensureColumn('sites', 'allow_circle', 'INTEGER DEFAULT 1');

  // Eén EXPLICIETE primaire/hoofd-site (= de bedrijfs-/labelsite in hub-modus,
  // de enige site in solo) i.p.v. de fragiele "oudste = hoofd"-conventie die op
  // 4 plekken gedupliceerd stond. Backfill: markeer de oudste als er nog geen
  // primaire site is, zodat bestaand gedrag exact behouden blijft.
  ensureColumn('sites', 'is_primary', 'INTEGER DEFAULT 0');
  try {
    const hasPrimary = db.prepare('SELECT 1 FROM sites WHERE is_primary = 1 LIMIT 1').get();
    if (!hasPrimary) {
      const oldest = db.prepare('SELECT id FROM sites ORDER BY created_at ASC LIMIT 1').get();
      if (oldest) db.prepare('UPDATE sites SET is_primary = 1 WHERE id = ?').run(oldest.id);
    }
  } catch (e) { /* sites-tabel nog leeg/afwezig bij verse init — ensurePrimarySite regelt 't */ }

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
  ensureColumn('sites', 'feed_view_default', "TEXT DEFAULT 'grid'"); // timeline | grid
  ensureColumn('sites', 'feed_view_switch',  'INTEGER DEFAULT 1');       // show switcher
  ensureColumn('sites', 'show_search',     'INTEGER DEFAULT 1');
  ensureColumn('sites', 'show_archive_link', 'INTEGER DEFAULT 1');

  // Per-post noindex + type
  ensureColumn('posts', 'noindex', 'INTEGER DEFAULT 0');
  ensureColumn('posts', 'type',    "TEXT DEFAULT 'post'");  // post | foto | video | audio

  // Statistieken (premium-module) — kale tellers, cookievrij.
  ensureColumn('posts', 'view_count', 'INTEGER DEFAULT 0');         // weergaven per post
  ensureColumn('audio_tracks', 'play_count', 'INTEGER DEFAULT 0');  // plays per track
  ensureColumn('audio_tracks', 'downloadable', 'INTEGER DEFAULT 0'); // download-voor-email (premium #2)

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

  // ── Statistieken (premium) — cookievrij ─────────────────────
  // stat_daily: per dag per site het aantal pageviews (kale teller).
  // stat_visitor_day: per dag per site een rij per UNIEKE bezoeker-hash
  //   (sha256 van IP+UA+dag-salt; de salt roteert dagelijks en wordt nooit
  //   bewaard → geen persistente identifier, geen cookie, geen toestemming nodig).
  db.exec(`
    CREATE TABLE IF NOT EXISTS stat_daily (
      site_id TEXT NOT NULL,
      day TEXT NOT NULL,
      pageviews INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, day)
    );
    CREATE TABLE IF NOT EXISTS stat_visitor_day (
      site_id TEXT NOT NULL,
      day TEXT NOT NULL,
      visitor_hash TEXT NOT NULL,
      PRIMARY KEY (site_id, day, visitor_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_stat_visitor_day ON stat_visitor_day(site_id, day);
  `);

  // ── Cirkels (federatie) ─────────────────────────────────────
  // Decentrale, asymmetrische verbindingen tussen solo-instances.
  db.exec(`
    CREATE TABLE IF NOT EXISTS circle_links (
      id TEXT PRIMARY KEY,
      local_site_id TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      remote_actor_id TEXT,
      label TEXT,
      status TEXT DEFAULT 'active',
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_synced DATETIME,
      last_error TEXT,
      UNIQUE(local_site_id, remote_url),
      FOREIGN KEY (local_site_id) REFERENCES sites(id)
    );
    CREATE TABLE IF NOT EXISTS remote_actors (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      name TEXT,
      summary TEXT,
      avatar TEXT,
      public_key TEXT NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS remote_posts (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      published DATETIME,
      title TEXT,
      summary TEXT,
      url TEXT,
      media_json TEXT,
      raw_json TEXT,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (actor_id) REFERENCES remote_actors(id)
    );
  `);

  // Tags van de originele post — getoond in de cirkel (comma-separated string).
  ensureColumn('remote_posts', 'tags', 'TEXT');

  // Nieuwsbrief / mailinglijst (premium). Abonnees per site; double opt-in als SMTP
  // er is (status 'pending' tot bevestigd), anders single opt-in ('confirmed').
  // 'unsub' = uitgeschreven. token = confirm/unsubscribe-sleutel (in de e-maillinks).
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscribers (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT DEFAULT 'widget',
      token TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_at DATETIME,
      UNIQUE(site_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_subscribers_site_status ON subscribers(site_id, status);
  `);

  // Verstuurde nieuwsbrieven (historie + aantallen).
  db.exec(`
    CREATE TABLE IF NOT EXISTS newsletters (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      recipient_count INTEGER DEFAULT 0
    );
  `);
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
