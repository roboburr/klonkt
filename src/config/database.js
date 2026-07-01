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
  // Google OAuth: link a Google account to a user (login via Google).
  ensureColumn('users', 'google_sub', 'TEXT');
  // Read-only/viewer account: can view everything but make no changes.
  ensureColumn('users', 'readonly', 'INTEGER DEFAULT 0');
  // Personal interface language (nl|en|de). Null = follow the default (site/env/browser).
  ensureColumn('users', 'lang', 'TEXT');
  // Site-level moderation toggle. 'trust' = auto-approve, 'moderate' = pending until reviewed.
  // Circles: whether this site may appear in other sites' circles (surfacing opt-out).
  ensureColumn('sites', 'allow_circle', 'INTEGER DEFAULT 1');

  // One EXPLICIT primary/main site (= the company/label site in hub mode,
  // the only site in solo) instead of the fragile "oldest = main" convention
  // that was duplicated in 4 places. Backfill: mark the oldest if no primary
  // site exists yet, so existing behaviour is preserved exactly.
  ensureColumn('sites', 'is_primary', 'INTEGER DEFAULT 0');
  try {
    const hasPrimary = db.prepare('SELECT 1 FROM sites WHERE is_primary = 1 LIMIT 1').get();
    if (!hasPrimary) {
      const oldest = db.prepare('SELECT id FROM sites ORDER BY created_at ASC LIMIT 1').get();
      if (oldest) db.prepare('UPDATE sites SET is_primary = 1 WHERE id = ?').run(oldest.id);
    }
  } catch (e) { /* sites table still empty/absent on fresh init — ensurePrimarySite handles it */ }

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
  ensureColumn('posts', 'publish_at', 'DATETIME');         // release planning (premium #3): scheduled go-live
  ensureColumn('posts', 'fan_only', 'INTEGER DEFAULT 0');  // fan-only preview (premium #3)
  ensureColumn('posts', 'nsfw',     'INTEGER DEFAULT 0');  // sensitive content → blur + click-to-reveal; fediverse sensitive
  ensureColumn('posts', 'cover_video_url', 'TEXT');        // muted loop MP4 for an animated cover (Safari-smooth)
  ensureColumn('posts', 'content_warning', 'TEXT');        // custom CW label (empty = default "Gevoelige inhoud")
  ensureColumn('posts', 'type',    "TEXT DEFAULT 'post'");  // post | foto | video | audio

  // Statistics (premium module) — bare counters, cookie-free.
  ensureColumn('posts', 'view_count', 'INTEGER DEFAULT 0');         // views per post
  ensureColumn('audio_tracks', 'play_count', 'INTEGER DEFAULT 0');  // plays per track
  ensureColumn('audio_tracks', 'downloadable', 'INTEGER DEFAULT 0'); // download-for-email (premium #2)
  ensureColumn('audio_tracks', 'credit', 'TEXT');   // owner/credit (copyright holder)
  ensureColumn('audio_tracks', 'license', 'TEXT');  // license (e.g. "CC BY 4.0", "All rights reserved")
  ensureColumn('audio_tracks', 'link_spotify',    'TEXT');  // "open in" links per track
  ensureColumn('audio_tracks', 'link_youtube',    'TEXT');
  ensureColumn('audio_tracks', 'link_soundcloud', 'TEXT');
  // Per-track: federate the actual audio file as an AS2 Audio attachment so it plays inline
  // in EVERY fediverse client (incl. the Mastodon apps). Default 0 = gated (web player only,
  // file not exposed). Opt-in 1 = the file is served ungated + shared on the fediverse.
  ensureColumn('audio_tracks', 'fedi_open', 'INTEGER DEFAULT 0');

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

  // Global app settings (key/value singleton). Includes the tenancy mode
  // (solo = one site, hub = company site + /user/). Default = solo.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('tenancy', 'solo')").run();

  // ── Statistics (premium) — cookie-free ──────────────────────
  // stat_daily: pageview count per day per site (bare counter).
  // stat_visitor_day: one row per UNIQUE visitor hash per day per site
  //   (sha256 of IP+UA+day-salt; the salt rotates daily and is never stored
  //   → no persistent identifier, no cookie, no consent required).
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
    CREATE TABLE IF NOT EXISTS stat_referrer (
      site_id TEXT NOT NULL,
      host TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, host)
    );
  `);

  // Newsletter / mailing list (premium). Subscribers per site; double opt-in when SMTP
  // is configured (status 'pending' until confirmed), otherwise single opt-in ('confirmed').
  // 'unsub' = unsubscribed. token = confirm/unsubscribe key (used in email links).
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

  // Sent newsletters (history + counts).
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

  // Show agenda (premium #8): tour dates / gigs per site.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shows (
      id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT,
      city TEXT NOT NULL,
      venue TEXT,
      country TEXT,
      ticket_url TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_shows_site_date ON shows(site_id, date);
  `);

  // Link-in-bio click statistics (premium #6). One counter per (site, url); the
  // link-in-bio page links via /links/go/:i which counts the click and redirects.
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_clicks (
      site_id TEXT NOT NULL,
      url TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (site_id, url)
    );
  `);


  // ── ActivityPub (fediverse bridge) ──────────────────────────
  // RSA keypair per actor (Mastodon-compatible HTTP Signatures; separate from
  // the Cirkels Ed25519 keys). ap_followers = remote AP actors following us.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ap_keys (
      slug TEXT PRIMARY KEY,
      public_pem TEXT NOT NULL,
      private_pem TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ap_followers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      actor_uri TEXT NOT NULL,
      inbox TEXT,
      shared_inbox TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, actor_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_followers_slug ON ap_followers(slug);
    CREATE TABLE IF NOT EXISTS ap_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,                   -- 'reply' | 'like' | 'announce'
      post_id TEXT NOT NULL,
      object_uri TEXT NOT NULL DEFAULT '',  -- remote note id (reply) or '' (like/announce)
      actor_uri TEXT NOT NULL,
      actor_name TEXT,
      actor_handle TEXT,
      actor_url TEXT,
      actor_icon TEXT,
      content TEXT,                         -- sanitized HTML (reply)
      published TEXT,
      parent_uri TEXT,                      -- the note this reply replies to (for nesting)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(kind, post_id, actor_uri, object_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_inter_post ON ap_interactions(post_id, kind);
    CREATE TABLE IF NOT EXISTS ap_outbox (
      id TEXT PRIMARY KEY,            -- note path segment (uuid) → /ap/notes/<id>
      site_slug TEXT NOT NULL,
      post_id TEXT NOT NULL,
      post_slug TEXT,
      in_reply_to TEXT,               -- remote status uri we reply to
      to_actor TEXT,                  -- remote actor uri (mentioned)
      to_handle TEXT,
      content TEXT NOT NULL,          -- sanitized HTML of our reply
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ap_outbox_post ON ap_outbox(post_id);
    -- Your like/boost state on a REMOTE post (the interact page), so those become toggles.
    CREATE TABLE IF NOT EXISTS ap_my_reactions (
      site_slug TEXT NOT NULL,
      target_uri TEXT NOT NULL,
      kind TEXT NOT NULL,             -- 'like' | 'boost'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_slug, target_uri, kind)
    );
  `);
  ensureColumn('ap_interactions', 'parent_uri', 'TEXT'); // nesting (existing DBs)
  ensureColumn('ap_interactions', 'acted_boost', 'INTEGER DEFAULT 0'); // owner boosted this comment (🔁) → can undo
  ensureColumn('ap_interactions', 'acted_like', 'INTEGER DEFAULT 0'); // owner liked this comment (⭐) → can undo

  // Fediverse CLIENT: accounts WE follow (outbound) + the home timeline of their posts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ap_following (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,            -- our site that follows
      actor_uri TEXT NOT NULL,       -- the followed account's actor id
      handle TEXT, name TEXT, icon TEXT, url TEXT,
      inbox TEXT,                    -- their inbox (for Create delivery / Undo)
      follow_id TEXT,                -- the Follow activity id we sent (Accept matching)
      status TEXT DEFAULT 'pending', -- pending | accepted
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, actor_uri)
    );
    CREATE TABLE IF NOT EXISTS ap_timeline (
      id TEXT NOT NULL,              -- the remote note's AP id
      slug TEXT NOT NULL,            -- whose home timeline (our site)
      author_uri TEXT, author_name TEXT, author_handle TEXT, author_icon TEXT, author_url TEXT,
      content TEXT, url TEXT, published TEXT, media_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_timeline_slug ON ap_timeline(slug, published);
    CREATE TABLE IF NOT EXISTS ap_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,          -- our site that set the block
      target TEXT NOT NULL,        -- actor URI (actor block) or domain (domain block)
      kind TEXT NOT NULL,          -- 'actor' | 'domain'
      label TEXT,                  -- display (@handle or domain)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, target)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_blocks_target ON ap_blocks(target);
    CREATE TABLE IF NOT EXISTS ap_delivery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,          -- our site/actor that signs the delivery
      inbox TEXT NOT NULL,         -- recipient inbox URL
      body TEXT NOT NULL,          -- the activity JSON to POST
      attempts INTEGER NOT NULL DEFAULT 0,
      next_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ap_delivery_due ON ap_delivery(next_at);
  `);
  // "Feature" a followed account: its posts show in the local Cirkel.
  ensureColumn('ap_following', 'auto_boost', 'INTEGER DEFAULT 0');
  // A timeline post you boosted (🔁) — also shown in the Cirkel (mixed by date).
  ensureColumn('ap_timeline', 'boosted', 'INTEGER DEFAULT 0');
  ensureColumn('ap_timeline', 'liked', 'INTEGER DEFAULT 0'); // a feed post you liked (⭐) → toggle
  ensureColumn('ap_timeline', 'nsfw', 'INTEGER DEFAULT 0');  // remote sensitive post → blur in the Cirkel
  ensureColumn('ap_timeline', 'cw', 'TEXT');                 // remote content-warning text
  ensureColumn('ap_timeline', 'reblog_name', 'TEXT');        // a followed account boosted this → "X boosted"
  ensureColumn('ap_timeline', 'reblog_handle', 'TEXT');      //   the booster's @handle
  ensureColumn('ap_timeline', 'reblog_icon', 'TEXT');        //   the booster's avatar
  ensureColumn('ap_timeline', 'poll_json', 'TEXT');          // a Question (poll): {multiple,options[{name,count}],endTime,closed,voters,voted}
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
