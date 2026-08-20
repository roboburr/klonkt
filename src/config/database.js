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
// With WAL + several concurrent writers (request handlers, the delivery worker, the
// background thread-crawler) a short write-lock should retry rather than throw SQLITE_BUSY.
db.pragma('busy_timeout = 5000');   // wait up to 5s for a lock instead of failing immediately
db.pragma('synchronous = NORMAL');  // safe with WAL (no torn writes); fewer fsyncs = faster writes

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
  // Eigenaarspoort (Robins wens, 18-8-2026): volgers niet automatisch
  // accepteren maar door de eigenaar laten beslissen, op z'n fediverse.
  // STANDAARD AAN (ook Robins wens, zelfde dag): een nieuwe of bijgewerkte
  // klonkt beschermt zijn eigenaar meteen; uitzetten is de bewuste keuze.
  ensureColumn('sites', 'approve_followers', 'INTEGER DEFAULT 1');
  // (Verwijderd 31-7-2026: sites.guardian_only en ap_guardian_invites hoorden
  // bij de guardian-lite accounts. Bestaande installaties houden kolom en tabel
  // ongebruikt; nieuwe krijgen ze niet meer.)
  // FEP-633c §5.3: follows targeting a ward are held pending until its
  // guardians approve (Guardian 2). Gating applies only to ward-actors.
  db.exec(`CREATE TABLE IF NOT EXISTS ap_pending_follows (
    id TEXT PRIMARY KEY,
    ward_slug TEXT NOT NULL,
    follower_uri TEXT NOT NULL,
    follower_inbox TEXT,
    follower_shared_inbox TEXT,
    follower_name TEXT,
    follower_handle TEXT,
    follower_icon TEXT,
    activity_json TEXT,
    quorum TEXT DEFAULT 'any',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS ap_pending_follow_approvals (
    follow_id TEXT NOT NULL,
    guardian_uri TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follow_id, guardian_uri)
  )`);
  // FEP-633c §5.3, the OTHER direction (shaer-p729): a ward's own follow is
  // held until its guardians approve. Deliberately not ap_pending_follows —
  // that table is keyed with the ward as the TARGET ("who wants to follow me"),
  // and adding a direction column would make every existing query ambiguous.
  db.exec(`CREATE TABLE IF NOT EXISTS ap_pending_outgoing_follows (
    id TEXT PRIMARY KEY,
    ward_slug TEXT NOT NULL,
    target_uri TEXT NOT NULL,
    target_inbox TEXT,
    target_name TEXT,
    target_handle TEXT,
    target_icon TEXT,
    quorum TEXT DEFAULT 'any',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_outgoing_follows_target
           ON ap_pending_outgoing_follows(ward_slug, target_uri)`);
  // Wat er gebeurd is, en waarom (shaer-p729, §4.2). Guardianship-events waren
  // vluchtig: onGuardianshipEvent wekte de long-poll en stuurde eventueel een
  // push, en de rest van de gebeurtenis loste op. Een weigering droeg
  // `reason: 'not_a_teapot'` tot in die functie en verder niet -- de ward en
  // zijn guardians hoorden het alleen doordat het aanbod uit de wachtrij
  // verdween. §4.2 eist dat ze het TE HOREN krijgen, met de reden erbij.
  //
  // Een logboek, geen wachtrij: hier staat niets dat om een antwoord vraagt.
  // Daarom hoort het ook ingeklapt te staan -- naast wat nog wel wacht, maakt
  // afgelopen nieuws de open vraag onleesbaar.
  db.exec(`CREATE TABLE IF NOT EXISTS ap_guardian_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ap_guardian_events_slug ON ap_guardian_events(slug, id DESC)');
  db.exec(`CREATE TABLE IF NOT EXISTS ap_outgoing_follow_approvals (
    follow_id TEXT NOT NULL,
    guardian_uri TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (follow_id, guardian_uri)
  )`);
  // Cross-instance follow-approval (modelled on the guardian offer): the
  // guardian-side COPY of a gated follow on a REMOTE ward, forwarded here by
  // the ward's server as an Offer(Follow). The decision is sent back to the
  // ward's inbox. (Local wards use ap_pending_follows directly.)
  db.exec(`CREATE TABLE IF NOT EXISTS ap_follow_reviews (
    id TEXT NOT NULL,
    guardian_slug TEXT NOT NULL,
    ward_uri TEXT NOT NULL,
    ward_inbox TEXT,
    follower_uri TEXT NOT NULL,
    follower_handle TEXT,
    follower_icon TEXT,
    follow_json TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (guardian_slug, id)
  )`);
  // Guardianship Fase 2 (shaer-jdb): een doorgestuurde follow-goedkeuring draagt
  // een RICHTING. Bij een inkomende is de follower iemand anders en de ward het
  // doel; bij een uitgaande is de ward zelf de follower en staat het doel in het
  // Follow-object. Zonder deze twee kolommen werd een uitgaande opgeslagen als
  // "deze ward wil deze ward volgen" en viel het doel weg -- dan valt er niets
  // zinnigs te tonen, hoe je de wachtrij ook vult.
  ensureColumn('ap_follow_reviews', 'direction', "TEXT DEFAULT 'incoming'");
  ensureColumn('ap_follow_reviews', 'target_uri', 'TEXT');
  ensureColumn('ap_follow_reviews', 'target_handle', 'TEXT');
  ensureColumn('sites', 'profile_photo', 'TEXT');
  // De MusicBrainz-koppeling van de artiest (shaer-mbz). Een MBID is een
  // verwijzing naar hun register, geen kopie ervan -- de naam staat erbij zodat
  // het beheerscherm kan tonen WAT er gekoppeld is zonder ervoor te moeten
  // netwerken, en zodat een verkeerde koppeling opvalt.
  ensureColumn('sites', 'mb_artist_id', 'TEXT');
  ensureColumn('sites', 'mb_artist_name', 'TEXT');
  // Een UITGAVE heeft twee dingen die een afspeellijst niet heeft (shaer-756s).
  //
  // release_date en niet `year`: die kolom bestaat al en blijft, maar hun
  // AlbumSerializer leest `released` als een DateField. Een jaartal als
  // 2024-01-01 versturen is een dag verzinnen, en dat is precies wat we bij
  // artiesten en albums niet doen. Volledige datum of niets.
  //
  // mb_release_id is de tegenhanger van sites.mb_artist_id: dezelfde soort
  // verwijzing naar MusicBrainz, een niveau lager.
  //
  // Ze horen ALLEEN bij kind='album'. PlaylistService dwingt dat af bij het
  // opslaan -- zie daar waarom dat niet alleen in het scherm mag zitten.
  ensureColumn('playlists', 'release_date', 'TEXT');
  ensureColumn('playlists', 'mb_release_id', 'TEXT');
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
  // Welke TWEEDE weergave deze site aanbiedt naast Grid.
  //   'reader'    Lezen, hele berichten, een per scherm
  //   'timeline'  de chronologische lijst
  //   'auto'      Lezen op mobiel, Tijdlijn op desktop (grens 768px)
  // Lezen verving Tijdlijn, maar de tijdlijn is nooit weggehaald -- home.ejs
  // rendert alle drie de secties en de CSS kiest. Dit maakt er weer een keuze
  // van in plaats van een besluit voor iedereen. 'auto' kost geen JavaScript:
  // het is een mediaquery, dus geen resize-afhandeling en geen flikkering.
  ensureColumn('sites', 'feed_alt_view', "TEXT DEFAULT 'reader'");   // reader | timeline | auto
  ensureColumn('sites', 'show_search',     'INTEGER DEFAULT 1');
  ensureColumn('sites', 'show_archive_link', 'INTEGER DEFAULT 1');
  // Gated feature (FEP-633c): may external (non-fediverse) embeds be shown to
  // this account? NULL = auto, which means OFF for a ward and ON for anyone
  // else. The guardians flip it; the gate itself lives server-side, so a ward
  // never even receives the thumbnail it is not allowed to see.
  ensureColumn('sites', 'external_embeds', 'INTEGER');
  // De rest van de gate-familie (shaer-ahy.1, "maak ze allemaal functioneel",
  // Barts opdracht 8-8). Zelfde drietal als external_embeds: NULL is de
  // automatiek (dicht voor een ward, open voor de rest), 0/1 is een besluit
  // van de guardians en wint van de automatiek.
  ensureColumn('sites', 'external_threads', 'INTEGER');   // replies van vreemden onder een post (shaer-9y2)
  ensureColumn('sites', 'gate_replies', 'INTEGER');       // zelf antwoorden in een gesprek (shaer-r4c)
  ensureColumn('sites', 'gate_images', 'INTEGER');        // afbeeldingsbijlagen (shaer-6p5)
  ensureColumn('sites', 'gate_messages', 'INTEGER');      // heel Messages (shaer-3ow)
  ensureColumn('sites', 'gate_compose', 'INTEGER');       // zelf posten, de (+) kaart (shaer-qgev)
  ensureColumn('sites', 'gate_music', 'INTEGER');         // audiobijlagen (shaer-rmz)
  ensureColumn('sites', 'gate_quote_cards', 'INTEGER');   // ingebedde quote-kaarten (shaer-mls)
  ensureColumn('sites', 'gate_custom_emoji', 'INTEGER');  // FEP-9098 emoji-plaatjes (shaer-ytw)
  ensureColumn('sites', 'gate_account_move', 'INTEGER');  // FEP-7628 Move (shaer-tge)
  // Wie de ward ZELF mag volgen (shaer-p729): de tegenhanger van shaer:follows,
  // dat over de andere richting gaat. §5.3 schrijft alleen het doorsturen voor
  // van een Follow NAAR een ward; wat je verder gated is een keuze van de
  // implementatie, en dit is die keuze. Verstelbaar, anders dan de inkomende
  // kant: een kind dat ouder wordt hoort niet eeuwig te blijven vragen.
  ensureColumn('sites', 'gate_following', 'INTEGER');     // zelf iemand volgen (shaer-p729)
  // The heavier sibling (FEP-633c 5.6): may a player from outside this app run
  // INSIDE it? A preview is a picture; playback hands the screen to a third
  // party's engine, recommendations and all. Two settings, so the guardians can
  // allow the one without the other. NULL = auto, which means off for a ward.
  ensureColumn('sites', 'external_playback', 'INTEGER');
  ensureColumn('sites', 'og_theme', 'TEXT');             // OG share-card variant: NULL=auto (follow site theme) | 'light' | 'dark'
  // FEP-7628: former identities this actor claims (JSON array of actor URIs).
  // Publishing them as alsoKnownAs is what lets the OLD server approve a Move
  // of its followers to this account — the claim must be visible on OUR side.
  ensureColumn('sites', 'ap_aliases', 'TEXT');
  ensureColumn('sites', 'moved_to', 'TEXT');   // FEP-7628 slice 2: waarheen dit account vertrok
  // FEP-1580: staat de ingest-routine nog open? 1 = klaar (en dat is ook de
  // stand van een site die nooit iets gemigreerd heeft, want er hangt niets).
  // Derden pollen op deze vlag, dus hij moet ook "er valt niets te wachten"
  // kunnen zeggen.
  ensureColumn('sites', 'migration_complete', 'INTEGER DEFAULT 1');

  // Per-post noindex + type
  ensureColumn('posts', 'noindex', 'INTEGER DEFAULT 0');
  ensureColumn('posts', 'publish_at', 'DATETIME');         // release planning (premium #3): scheduled go-live
  ensureColumn('posts', 'fan_only', 'INTEGER DEFAULT 0');  // fan-only preview (premium #3)
  ensureColumn('posts', 'nsfw',     'INTEGER DEFAULT 0');  // sensitive content → blur + click-to-reveal; fediverse sensitive
  ensureColumn('posts', 'cover_video_url', 'TEXT');        // muted loop MP4 for an animated cover (Safari-smooth)
  ensureColumn('posts', 'cover_alt', 'TEXT');              // alt text / description for the cover (a11y → AS2 attachment `name`)
  ensureColumn('posts', 'language', 'TEXT');               // BCP-47 content language → federates as AS2 contentMap (Mastodon language filter/translate)
  ensureColumn('posts', 'content_warning', 'TEXT');        // custom CW label (empty = default "Gevoelige inhoud")
  ensureColumn('posts', 'type',    "TEXT DEFAULT 'post'");  // post | foto | video | audio
  ensureColumn('posts', 'poll_json', 'TEXT');              // a poll WE host → federates as AS2 Question: {multiple,options[{name}],endTime,closed}

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

  // Global app settings (key/value singleton). One instance is one owner, so
  // there is no tenancy mode here anymore — see SettingsService.
  // Oudere installaties dragen nog een dode rij key='tenancy' ('solo' of
  // 'circle'). Niets leest hem; bewust laten staan (shaer-x7c0) in plaats van
  // er opruimcode voor te schrijven die na één ronde zelf dood is.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

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
    );    -- LUISTERAARS (shaer-0nh). Wie de BIBLIOTHEEK volgt, niet de actor.
    --
    -- Een eigen tabel en niet een vlag op ap_followers, en dat is met opzet:
    -- deze accounts horen onze gewone posts NIET te krijgen. Zolang ze in een
    -- andere tabel staan kan een bezorging ze niet per ongeluk meenemen -- een
    -- vlag die iemand vergeet te filteren zou dat wel doen, en dan komt de
    -- Krant van een site bij mensen die alleen muziek wilden.
    CREATE TABLE IF NOT EXISTS ap_library_followers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      actor_uri TEXT NOT NULL,
      inbox TEXT,
      shared_inbox TEXT,
      name TEXT,
      handle TEXT,
      icon TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_delivery_at DATETIME,
      last_error_at DATETIME,
      UNIQUE (slug, actor_uri)
    );

    -- OpenWebAuth (FEP-61cf): eenmalige tokens waarmee een BEZOEKER van elders
    -- bewijst wie hij is. Klonkt is hier de 'target instance': we hebben nooit
    -- iemands prive-sleutel nodig, alleen zijn publieke -- dus staat hier ook
    -- geen geheim van een ander in.
    --
    -- Het token is kort houdbaar (minuten, zie OpenWebAuthService) en gaat na
    -- inwisselen meteen weg: eenmalig is de hele bedoeling. De FEP noemt de
    -- opruiming expliciet als DoS-verdediging -- zonder vervaltijd vult iemand
    -- deze tabel met tokens die hij nooit inwisselt.
    CREATE TABLE IF NOT EXISTS owa_tokens (
      token TEXT PRIMARY KEY,
      actor_uri TEXT NOT NULL,
      created_at INTEGER NOT NULL          -- ms sinds epoch
    );
    CREATE INDEX IF NOT EXISTS idx_owa_tokens_created ON owa_tokens(created_at);

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
    -- Moderation tombstones: object URIs the site owner removed. Checked at ingest
    -- (handleInbox) AND by the thread-crawler, so a removed reply never comes back
    -- via thread-filling. Private notes can't be flagged via authorize_interaction
    -- (their fetch 401s), so owner moderation acts on the locally stored copy.
    CREATE TABLE IF NOT EXISTS ap_rejected_objects (
      object_uri TEXT PRIMARY KEY,
      post_id TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- ActivityPub C2S (client-to-server): OAuth 2.0 for native/web clients (Shaer).
    -- Public clients + PKCE (RFC 8252); tokens stored hashed; token is per user+site.
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      redirect_uris TEXT NOT NULL,        -- JSON array
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS oauth_codes (
      code TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      site_slug TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT,                -- PKCE S256 (verplicht voor public clients)
      scope TEXT,
      expires_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token_hash TEXT PRIMARY KEY,        -- sha256(bearer); het token zelf slaan we nooit op
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      site_slug TEXT NOT NULL,
      scope TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME
    );
    -- Paid posts (klonkt-demo-aki): the site owner's own Patreon campaign.
    -- Secrets are encrypted at rest (CryptoBox). Never reuses the instance-level
    -- patreon_* settings, which are Klonkt Premium's separate license flow.
    CREATE TABLE IF NOT EXISTS paid_patreon (
      site_id TEXT PRIMARY KEY,
      client_id TEXT,
      client_secret_enc TEXT,
      campaign_id TEXT,
      access_token_enc TEXT,
      refresh_token_enc TEXT,
      token_exp INTEGER,               -- unix seconds
      default_min_cents INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- One row per passkey. NO patron identity is stored (design decision):
    -- {passkey, site, proven cents, expiry}. Not traceable to a person.
    CREATE TABLE IF NOT EXISTS paid_entitlements (
      credential_id TEXT PRIMARY KEY,   -- WebAuthn credential id (opaque, base64url)
      site_id TEXT NOT NULL,
      public_key TEXT NOT NULL,         -- COSE public key, base64url
      counter INTEGER DEFAULT 0,
      transports TEXT,
      min_cents INTEGER DEFAULT 0,      -- the amount proven at link time
      expires_at INTEGER NOT NULL,      -- unix seconds; re-link after
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Web Push (docs/webpush-design.md): one row per browser/device the owner
    -- enabled notifications on. Payloads are encrypted to p256dh/auth (RFC 8291).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,       -- push-service URL for this device
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,            -- client public key
      auth TEXT NOT NULL,              -- client auth secret
      alert_types TEXT,                -- JSON {follow,reply,like,boost,dm}
      ua_label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_ok_at DATETIME
    );
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
    -- Antwoorden van accounts die we volgen komen gewoon binnen, ondertekend
    -- door de schrijver, maar horen niet in de Krant (belongsInTimeline) en
    -- werden daarna nergens bewaard. Kwam er later een doorgestuurd antwoord OP
    -- zo'n bericht, dan kenden we de ouder niet en wezen we het af (shaer-e9g).
    -- Alleen de URI, geen inhoud: dit voedt uitsluitend de vraag "kennen wij dit
    -- bericht?". Wordt na 30 dagen gesnoeid; doorsturen gebeurt kort na het
    -- antwoord, dus langer bewaren levert niets op.
    CREATE TABLE IF NOT EXISTS ap_seen_notes (
      uri TEXT PRIMARY KEY,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ap_seen_notes_age ON ap_seen_notes(created_at);
    CREATE TABLE IF NOT EXISTS ap_timeline (
      id TEXT NOT NULL,              -- the remote note's AP id
      slug TEXT NOT NULL,            -- whose home timeline (our site)
      author_uri TEXT, author_name TEXT, author_handle TEXT, author_icon TEXT, author_url TEXT,
      content TEXT, url TEXT, published TEXT, media_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, id)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_timeline_slug ON ap_timeline(slug, published);
    -- canonicalReactionUri herleidt een permalink naar het object-id door op (slug, url)
    -- te zoeken. Zonder deze index viel dat terug op idx_ap_timeline_slug, dus een scan
    -- van elke rij van die slug. Dat gebeurt PER REACTIE in getInteractions, en de
    -- reactie-migratie erft het in haar re-key-join, die synchroon vóór listen draait:
    -- de opstartkosten waren reacties maal tijdlijnrijen.
    CREATE INDEX IF NOT EXISTS idx_ap_timeline_url ON ap_timeline(slug, url);
    -- FEP-1580: de vertaaltabel van een verhuizing. Per gemigreerd object waar
    -- het VANDAAN kwam en welke URI het HIER kreeg. Derden lezen deze mapping en
    -- werken er hun eigen inReplyTo/Like-verwijzingen mee bij; zonder deze tabel
    -- is "de berichten krijgen nieuwe adressen" een permanent kapotte draad.
    --
    -- De spec eist omgekeerd-chronologisch op het moment dat de kopie HIER is
    -- aangemaakt (niet de oorspronkelijke publicatiedatum). Daarom sorteren we
    -- op de autoincrement-id en niet op created_at: die heeft secondeprecisie,
    -- en een ingest zet er tientallen per seconde in.
    CREATE TABLE IF NOT EXISTS ap_migration (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,          -- onze site, de DOELkant van de verhuizing
      origin TEXT NOT NULL,        -- object-URI op de broninstantie
      target TEXT NOT NULL,        -- de URI die het object hier kreeg
      source_actor TEXT NOT NULL DEFAULT '',
      is_public INTEGER NOT NULL DEFAULT 1,   -- niet-publieke items horen niet in een publieke pagina
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, origin)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_migration_slug ON ap_migration(slug, id DESC);
    -- De Move-activities zelf, gededupliceerd. FEP-1580 wil dat deze collectie
    -- een op zichzelf staand bewijs vormt voor de items in ap_migration, met een
    -- FEP-8b32 integrity proof van de bron-actor plus een kopie van diens
    -- actor-document. Wij bewaren allebei die stukken al (activity_json en
    -- actor_json), maar Klonkt kent 8b32 nog niet: zie shaer-j1v0. Zolang dat
    -- open staat is deze collectie structureel goed en niet verifieerbaar.
    CREATE TABLE IF NOT EXISTS ap_moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      move_id TEXT NOT NULL,       -- id van de Move-activity, tevens dedup-sleutel
      source_actor TEXT NOT NULL,
      target_actor TEXT NOT NULL,
      activity_json TEXT NOT NULL,
      actor_json TEXT,             -- inline kopie van het bron-actordocument
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, move_id)
    );
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
    -- Committed guardian ↔ ward relations, one row per local side. role
    -- 'ward' = the local slug is a ward of other_uri; 'guardian' = the local
    -- slug guards other_uri. status is always 'accepted' here now: PENDING
    -- offers live in ap_guardian_offers below (FEP-633c multi-party handshake).
    CREATE TABLE IF NOT EXISTS ap_guardianships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,          -- our local site in this relation (guardianship module)
      role TEXT NOT NULL,          -- 'guardian' (slug guards other) | 'ward' (other guards slug)
      other_uri TEXT NOT NULL,     -- the counterpart actor URI (local or remote)
      other_handle TEXT,           -- cached @user@host for display
      status TEXT NOT NULL,        -- 'offered' (legacy) | 'accepted'
      offer_id TEXT,               -- the Offer activity id (FEP-633c section 3)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, role, other_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_guardianships_slug ON ap_guardianships(slug, role, status);
    -- The multi-party handshake (FEP-633c section 3), one row per offer this
    -- instance is a party to. Mirrors the Shaer test daemon's Handshake:
    -- accepts accumulate in ap_guardian_offer_accepts, and the offer commits
    -- only when the candidate returns the handle after ward + candidate + at
    -- least one existing guardian have accepted.
    CREATE TABLE IF NOT EXISTS ap_guardian_offers (
      offer_id TEXT NOT NULL,      -- the Offer activity id (minted by the candidate)
      slug TEXT NOT NULL,          -- the local site tracking this handshake (each party keeps its own copy)
      ward_uri TEXT NOT NULL,      -- the ward-to-be
      candidate_uri TEXT NOT NULL, -- the guardian-candidate (fixed initiator)
      existing_guardians TEXT NOT NULL DEFAULT '[]',  -- JSON array of the ward's current guardian URIs
      status TEXT NOT NULL DEFAULT 'pending',         -- 'pending' | 'committed' | 'void'
      handle TEXT,                 -- the escalation handle returned at commit (section 6)
      ward_handle TEXT,            -- cached @ward@host for display
      candidate_handle TEXT,       -- cached @candidate@host for display
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (slug, offer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_guardian_offers_slug ON ap_guardian_offers(slug, status);
    CREATE TABLE IF NOT EXISTS ap_guardian_offer_accepts (
      offer_id TEXT NOT NULL,      -- FK to ap_guardian_offers
      slug TEXT NOT NULL,          -- the local site's copy of the tally
      party_uri TEXT NOT NULL,     -- the party who accepted (ward | candidate | an existing guardian)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (slug, offer_id, party_uri)
    );
    -- FEP-633c §5.6: a gated setting a ward's guardians decide together, which
    -- has to work when they live on other servers (the ordinary case). One row
    -- per guardian answer; the ward's server tallies (§3.5) and enforces.
    -- The proposals themselves, so an Accept that only references the offer
    -- id can still be resolved to "which feature, which value".
    CREATE TABLE IF NOT EXISTS ap_gated_offers (
      offer_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,          -- the ward, on this server
      feature TEXT NOT NULL,
      value INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- The guardian-side COPY of a gated-setting proposal on a ward, forwarded
    -- here by the WARD's server (the same shape ap_follow_reviews has for a
    -- gated follow). Without it a guardian on another server never learns a
    -- proposal exists and can never answer it, so a threshold of two can never
    -- be reached and every proposal expires. The answer goes back to the
    -- ward's inbox, which tallies (5.6).
    CREATE TABLE IF NOT EXISTS ap_gated_reviews (
      id TEXT NOT NULL,            -- the offer id, as minted by the proposer
      guardian_slug TEXT NOT NULL, -- us, one of the ward's guardians
      ward_uri TEXT NOT NULL,
      ward_inbox TEXT,
      proposer TEXT,               -- who opened it (for display)
      feature TEXT NOT NULL,
      value INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (guardian_slug, id)
    );
    -- The PROPOSER's own record of a gated proposal it sent (5.6). Without it
    -- a guardian clicks "propose", the ward's server tallies somewhere else,
    -- and the proposer has nowhere to even see that something is running: the
    -- status was a button caption that did not survive a page refresh. The
    -- ward's server answers the Offer once the decision settles (Accept when
    -- it settled on the proposed value, Reject otherwise); that answer lands
    -- in status. An open row past the decision window renders as expired.
    CREATE TABLE IF NOT EXISTS ap_gated_sent (
      offer_id TEXT PRIMARY KEY,   -- as minted by us, the proposer
      guardian_slug TEXT NOT NULL, -- us
      ward_uri TEXT NOT NULL,
      feature TEXT NOT NULL,
      value INTEGER NOT NULL,      -- what we proposed
      status TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'accepted' | 'rejected'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ap_gated_votes (
      slug TEXT NOT NULL,          -- the WARD, on this server
      feature TEXT NOT NULL,       -- e.g. 'shaer:externalEmbeds'
      guardian_uri TEXT NOT NULL,  -- who answered (must be a committed guardian)
      value INTEGER NOT NULL,      -- the value they voted for (0/1)
      opened_at DATETIME NOT NULL, -- when this decision opened (the window start)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (slug, feature, guardian_uri)
    );
    -- Guardian availability (FEP-633c 3.6): one guardian's attention as seen
    -- from one ward on this server. Never public; the ward reads it via the
    -- owner-only guardians queue. One rule above all: one answer restores
    -- everything, so every row here is one answer away from disappearing.
    CREATE TABLE IF NOT EXISTS ap_guardian_attention (
      ward_slug TEXT NOT NULL,
      guardian_uri TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'away' | 'dormant'
      away_until INTEGER,                    -- epoch ms while declared away
      PRIMARY KEY (ward_slug, guardian_uri)
    );
    -- The ONLY admissible dormancy evidence (3.6.2): directly addressed
    -- requests that went unanswered. Calendar time alone never counts.
    CREATE TABLE IF NOT EXISTS ap_attention_requests (
      ward_slug TEXT NOT NULL,
      guardian_uri TEXT NOT NULL,
      request_id TEXT NOT NULL,
      asked_at INTEGER NOT NULL,             -- epoch ms
      PRIMARY KEY (ward_slug, guardian_uri, request_id)
    );
    -- A lapse (3.6.3): the available co-guardians deciding to release a
    -- dormant one. Irreversible, so the window always runs in full; any sign
    -- of life from the target cancels it outright.
    CREATE TABLE IF NOT EXISTS ap_lapses (
      id TEXT PRIMARY KEY,
      ward_slug TEXT NOT NULL,
      ward_uri TEXT NOT NULL,
      target_uri TEXT NOT NULL,
      opened_by TEXT NOT NULL,
      set_json TEXT NOT NULL,                -- the available set at open, target excluded
      accepts_json TEXT NOT NULL DEFAULT '[]',
      rejects_json TEXT NOT NULL DEFAULT '[]',
      opened_at INTEGER NOT NULL,            -- epoch ms
      window_ms INTEGER NOT NULL,
      cancelled INTEGER NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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
    CREATE TABLE IF NOT EXISTS poll_votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,     -- our local poll post (posts.id)
      actor_uri TEXT NOT NULL,      -- the remote voter's AP actor URI
      choice TEXT NOT NULL,         -- the chosen option's name (matches poll_json options[].name)
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(post_id, actor_uri, choice)
    );
    CREATE INDEX IF NOT EXISTS idx_poll_votes_post ON poll_votes(post_id);
    CREATE TABLE IF NOT EXISTS ap_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,           -- our mentioned site/actor
      object_uri TEXT NOT NULL,     -- the remote note that mentions us
      note_url TEXT,                -- its human URL (open/interact)
      actor_uri TEXT, actor_name TEXT, actor_handle TEXT, actor_icon TEXT, actor_url TEXT,
      content TEXT,                 -- sanitized HTML snippet of the mentioning note
      published TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(slug, object_uri)
    );
    CREATE INDEX IF NOT EXISTS idx_ap_mentions_slug ON ap_mentions(slug, created_at);
    CREATE TABLE IF NOT EXISTS ap_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,           -- our site the report is about (its owner moderates)
      actor_uri TEXT,               -- the reporter's actor URI
      actor_name TEXT, actor_handle TEXT, actor_icon TEXT,
      content TEXT,                 -- the reason (plain text)
      objects TEXT,                 -- JSON array of reported object URIs (our actor + statuses)
      seen INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ap_reports_slug ON ap_reports(slug, created_at);
  `);
  // "Feature" a followed account: its posts show in the local Cirkel. Heet in de
  // UI "Uitgelicht" / "Featured" (tl.autoboost), en zo heet de kolom ook in
  // following.csv. Niet te verwarren met `featured` op de ACTOR: dat is de
  // collectie vastgezette POSTS (toot:featured), iets heel anders.
  ensureColumn('ap_following', 'auto_boost', 'INTEGER DEFAULT 0');
  // A timeline post you boosted (🔁) — also shown in the Cirkel (mixed by date).
  ensureColumn('ap_timeline', 'boosted', 'INTEGER DEFAULT 0');
  ensureColumn('ap_timeline', 'liked', 'INTEGER DEFAULT 0'); // a feed post you liked (⭐) → toggle
  ensureColumn('ap_timeline', 'nsfw', 'INTEGER DEFAULT 0');  // remote sensitive post → blur in the Cirkel
  ensureColumn('ap_timeline', 'cw', 'TEXT');                 // remote content-warning text
  ensureColumn('ap_timeline', 'emoji_json', 'TEXT');         // FEP-9098 custom emoji Emoji tags from the inbound note, served back as `tag`
  ensureColumn('ap_timeline', 'link_json', 'TEXT');          // FEP-e232 object-link (quote/ref) tags from the inbound note, served back as `tag`
  ensureColumn('ap_timeline', 'quote_json', 'TEXT');         // FEP-044f resolved quoted-post snapshot (author + content), for the embedded quote card
  // FEP-044f: the fediverse object THIS post quotes, resolved once at publish
  // time so buildNote (sync, also used by the outbox) needs no network.
  ensureColumn('posts', 'quote_uri', 'TEXT');     // the quoted object's id
  // De kaart op je EIGEN post (shaer-k3f): dezelfde snapshots die ap_timeline
  // voor binnenkomende posts draagt, maar dan voor wat je zelf publiceert --
  // zonder deze twee kan de app een eigen post nooit als kaart tonen.
  ensureColumn('posts', 'quote_json', 'TEXT');    // FEP-044f resolved quote snapshot
  ensureColumn('posts', 'embed_json', 'TEXT');    // externe linkkaart (oEmbed/OG), thumbnail-only
  ensureColumn('posts', 'quote_actor', 'TEXT');   // its author, so we can address them
  ensureColumn('ap_timeline', 'embed_json', 'TEXT');       // resolved EXTERNAL embed (oEmbed/provider), thumbnail-only; gated per site (sites.external_embeds)
  ensureColumn('ap_timeline', 'author_emoji_json', 'TEXT');  // FEP-9098 custom emojis in the author's display name (shaer:author.emojis)
  ensureColumn('ap_timeline', 'reblog_emoji_json', 'TEXT');  // FEP-9098 custom emojis in the booster's display name (shaer:booster.emojis)
  ensureColumn('ap_timeline', 'reblog_name', 'TEXT');        // a followed account boosted this → "X boosted"
  ensureColumn('ap_timeline', 'reblog_handle', 'TEXT');      //   the booster's @handle
  ensureColumn('ap_timeline', 'reblog_icon', 'TEXT');        //   the booster's avatar
  ensureColumn('ap_timeline', 'poll_json', 'TEXT');          // a Question (poll): {multiple,options[{name,count}],endTime,closed,voters,voted}

  // Delivery health per follower → surface dead accounts for manual cleanup.
  ensureColumn('ap_followers', 'last_delivery_at', 'DATETIME'); // last SUCCESSFUL delivery to this follower's inbox
  ensureColumn('ap_followers', 'last_error_at', 'DATETIME');    // last time a delivery to it gave up (max retries)

  // ActivityPub `source` model: content_rendered = baked display HTML (#hashtags / URLs /
  // @mentions linkified once at save). `content` stays the raw source used for editing and
  // re-rendering. NULL on old posts → the render route bakes on the fly as a fallback.
  ensureColumn('posts', 'content_rendered', 'TEXT');

  // AP addressing of an incoming interaction: 'public' | 'unlisted' | 'followers' | 'direct',
  // derived from the note's to/cc at ingest. The public post page only renders public/unlisted
  // replies; followers/direct replies surface in notifications (and later Messages) with post
  // context instead. Existing rows default to 'public' (historically almost all were).
  ensureColumn('ap_interactions', 'visibility', "TEXT DEFAULT 'public'");
  ensureColumn('ap_interactions', 'emoji_json', 'TEXT');        // FEP-9098 custom emojis in a reply's content (messages + thread)
  ensureColumn('ap_interactions', 'actor_emoji_json', 'TEXT');  // FEP-9098 custom emojis in the reply author's display name
  // Rich replies: the reply's language (BCP47 code) → contentMap on the outgoing Note.
  ensureColumn('ap_outbox', 'language', 'TEXT');
  // Rich replies: JSON array [{url, mediaType, name}] → `attachment` on the Note.
  ensureColumn('ap_outbox', 'attachments', 'TEXT');
  ensureColumn('posts', 'ap_visibility', 'TEXT');   // public|quiet|friends|direct (C2S addressing, shaer-60b)
  ensureColumn('posts', 'paid', 'INTEGER DEFAULT 0');        // paid post (klonkt-demo-aki)
  ensureColumn('posts', 'paid_min_cents', 'INTEGER');        // required support; null = owner default
  ensureColumn('paid_patreon', 'patreon_url', 'TEXT');       // owner's public Patreon page → "Word supporter" link (klonkt-demo-aki)
  ensureColumn('ap_outbox', 'visibility', 'TEXT');  // 'direct' = private mention, never Public (shaer-tqc)
  ensureColumn('ap_outbox', 'to_actors', 'TEXT');   // JSON array of recipient actor URIs for direct notes
  ensureColumn('ap_outbox', 'help_request', 'INTEGER'); // FEP-633c shaer:helpRequest (ward's call for help)
  // Wie er op een hulpvraag af is, en wanneer hij is afgesloten (shaer-lgo).
  // Los van ap_mentions, want dit is GEDEELDE staat: elke guardian van dit kind
  // heeft er een kopie van, en die komt binnen als bericht van een ander. Een
  // kolom op de mention zou alleen over onszelf gaan.
  //
  // OPGEPIKT mag stapelen: twee mensen die tegelijk reageren op een kind dat om
  // hulp vraagt is geen probleem. Twee mensen die allebei niets doen omdat de
  // ander het "geclaimd" had, wel.
  //
  // AFGEHANDELD kent geen terugdraai. Sluiten gebeurt met een stevige
  // bevestiging, en leeft de vraag daarna nog, dan wordt hij opnieuw gesteld --
  // een nieuwe hulpvraag. Zo blijft het verslag eerlijk: er wordt niets
  // herschreven, er wordt toegevoegd.
  db.exec(`CREATE TABLE IF NOT EXISTS ap_help_state (
    note_uri TEXT NOT NULL,
    guardian_uri TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- pickup | handled
    guardian_handle TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (note_uri, guardian_uri, kind)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ap_help_state_note ON ap_help_state(note_uri)');
  // Een kind dat zelf om een poort vraagt (shaer-8ru). Een VRAAG, geen stem:
  // pas als een guardian hem oppakt wordt het een voorstel dat langs de tally
  // gaat. handled_at in plaats van verwijderen -- wat een kind gevraagd heeft
  // hoort terug te vinden te zijn, ook als het antwoord nee was.
  db.exec(`CREATE TABLE IF NOT EXISTS ap_gate_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL,                 -- de guardian die hem ontving
    ward_uri TEXT NOT NULL,
    feature TEXT NOT NULL,
    note_uri TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    handled_at TEXT,
    UNIQUE (slug, ward_uri, feature, handled_at)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ap_gate_requests_slug ON ap_gate_requests(slug, handled_at)');
  ensureColumn('ap_mentions', 'help_request', 'INTEGER'); // inbound ward call-for-help (Guardian PWA message centre)
  ensureColumn('ap_outbox', 'wave', 'INTEGER');    // FEP-633c shaer:wave (guardian -> ward nudge)
  ensureColumn('ap_outbox', 'away_until', 'INTEGER'); // FEP-633c 3.6.1 shaer:away + endTime (epoch ms)
  ensureColumn('ap_gated_offers', 'proposer', 'TEXT'); // who proposed (5.6): the settle-answer goes back to them
  // Zou JOUW antwoord het besluit afmaken (shaer-8vt)? De telling loopt op de
  // server van het kind; zonder dit veld kan een guardian elders niet weten dat
  // hij de doorslag geeft. Ontbreekt hij, dan waarschuwen we -- bij twijfel.
  ensureColumn('ap_gated_reviews', 'decisive', 'INTEGER');
  // Did a guardian actually say yes to this follower? That is what makes the
  // mutual shortcut sound: a ward may follow back anyone its guardians already
  // admitted, without asking the same question twice. Only follows that came
  // through the §5.3 gate carry the mark; a free actor's followers never faced
  // one. Everyone already following when this column arrives is grandfathered
  // in (Barts besluit, 3-8): the rule is exact from that moment forward rather
  // than retroactively suspicious of relationships that already exist.
  {
    const had = db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('ap_followers') WHERE name = 'gate_approved'").get();
    ensureColumn('ap_followers', 'gate_approved', 'INTEGER DEFAULT 0');
    if (!had || !had.n) {
      try { db.prepare('UPDATE ap_followers SET gate_approved = 1').run(); } catch { /* table still empty on a fresh init */ }
    }
  }
  ensureColumn('posts', 'c2s_attachments', 'TEXT'); // media a C2S Note carried (JSON [{url,mediaType,name}]); buildNote federates them
  // 30-7: C2S posts briefly got their content media copied onto the cover,
  // which showed the same video twice on the post page. Clear the covers that
  // duplicate their own content; idempotent, only ever touches those.
  try {
    db.prepare("UPDATE posts SET cover_video_url = NULL WHERE cover_video_url LIKE '/media/reply-media/%' AND instr(content, cover_video_url) > 0").run();
    db.prepare("UPDATE posts SET cover_image_url = NULL WHERE cover_image_url LIKE '/media/reply-media/%' AND instr(content, cover_image_url) > 0").run();
  } catch { /* posts table absent on fresh init */ }
  ensureColumn('ap_mentions', 'wave', 'INTEGER');  // inbound guardian wave
  // FEP-633c §2.2: object hint that the author is a ward. Register-only for now;
  // used later at reddings-boei / escalation routing.
  ensureColumn('ap_timeline', 'has_guardians', 'INTEGER');
  ensureColumn('ap_mentions', 'has_guardians', 'INTEGER');
  // Berichten and de Krant render a post the same way, so a mention or a reply
  // needs the same trimmings a timeline row already has: custom emojis, the
  // media the note carried, and the quote / link-preview card.
  ensureColumn('ap_mentions', 'emoji_json', 'TEXT');        // FEP-9098, in the content
  ensureColumn('ap_mentions', 'actor_emoji_json', 'TEXT');  // FEP-9098, in the display name
  ensureColumn('ap_mentions', 'media_json', 'TEXT');
  ensureColumn('ap_mentions', 'quote_json', 'TEXT');        // FEP-044f quoted post
  ensureColumn('ap_mentions', 'embed_json', 'TEXT');        // external link preview
  ensureColumn('ap_interactions', 'media_json', 'TEXT');
  ensureColumn('ap_interactions', 'quote_json', 'TEXT');
  ensureColumn('ap_interactions', 'embed_json', 'TEXT');
  ensureColumn('ap_followers', 'name', 'TEXT');    // cached display name (shaer-aa3)
  ensureColumn('ap_followers', 'handle', 'TEXT');  // @user@host
  ensureColumn('ap_followers', 'icon', 'TEXT');    // avatar URL
  feedStateTriggers();
}

/**
 * Wat er met een tijdlijn gebeurd is, op één plek (shaer-n05).
 *
 * De inbox-lezing voegt vier bronnen samen. De vraag "is er iets veranderd" werd
 * eerst beantwoord met MAX(rowid) over die vier -- een TOEVALLIGE eigenschap van
 * de tabellen, geen feit dat ergens is opgeschreven. Dat gaf precies de gebreken
 * die je van zo'n afleiding verwacht: bewerkingen en verwijderingen bewogen hem
 * niet, en hij kon achteruit lopen. Dezelfde fout als reacties uitlezen uit
 * ap_timeline.liked (shaer-9e9).
 *
 * Nu één rij per bericht per tijdlijn, met een oplopende `rev` en `kind`. Dat
 * beantwoordt drie vragen die anders drie eigen oplossingen zouden krijgen:
 * is er iets veranderd sinds N, wát is er veranderd, en is dit bericht bewerkt.
 *
 * Bijgehouden door TRIGGERS en niet door de aanroepende code, om dezelfde reden
 * dat er geen gebeurtenis-emitter is: een trigger zit in de database, dus geen
 * enkel codepad kan hem vergeten. De prijs is onzichtbare logica -- wie alleen de
 * JavaScript leest ziet niet waarom deze tabel vult. Vandaar dat ze hier staan,
 * bij de tabel, en niet verspreid.
 *
 * Let op de `UPDATE OF`-kolomlijsten: die zijn niet decoratief. Een like schrijft
 * ap_timeline.liked en een 🔁 schrijft .boosted; zonder die afbakening zou je
 * eigen like het bericht als BEWERKT merken en elke wachtende client wekken.
 */
function feedStateTriggers() {
  try {
    db.exec(`
      -- Tot waar jij een gesprek gelezen hebt (shaer-frontend-3tx).
      --
      -- Een MARKERING, geen teller: het aantal ongelezen berichten is een
      -- COUNT over de berichten die na deze cursor komen. Een opgeslagen
      -- getal zou opgehoogd, verlaagd en gerepareerd moeten worden, en zou
      -- blijven staan als er iets verwijderd wordt -- badge zegt 3, er is
      -- niets.
      --
      -- De cursor is samengesteld ('<stempel>|<ref>'), dezelfde vorm als de
      -- gesprekspaginering en om dezelfde reden: twee berichten in dezelfde
      -- seconde is bij DM's een gesprek, geen randgeval.
      CREATE TABLE IF NOT EXISTS ap_read_markers (
        slug TEXT NOT NULL,
        other TEXT NOT NULL,          -- de tegenpartij (actor uri)
        cursor TEXT NOT NULL,
        at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (slug, other)
      );
      CREATE TABLE IF NOT EXISTS ap_feed_state (
        slug TEXT NOT NULL,
        object_uri TEXT NOT NULL,
        rev INTEGER NOT NULL,
        kind TEXT NOT NULL,             -- new | updated | deleted
        at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (slug, object_uri)
      );
      CREATE INDEX IF NOT EXISTS idx_ap_feed_state_rev ON ap_feed_state(slug, rev);
      -- Eén doorlopende teller voor de hele instance. Bewust niet MAX(rev) uit de
      -- tabel zelf: verdwijnt de hoogste rij, dan zou die teruglopen en denkt een
      -- client dat er niets gebeurd is.
      CREATE TABLE IF NOT EXISTS ap_feed_rev (n INTEGER NOT NULL);
    `);
    if (!db.prepare('SELECT COUNT(*) AS n FROM ap_feed_rev').get().n) {
      db.prepare('INSERT INTO ap_feed_rev (n) VALUES (0)').run();
    }
    // slug + object_uri verschillen per bron; de rest is voor alle vier gelijk.
    const zet = (naam, gebeurtenis, tabel, slug, uri, kind, extra = '', wanneer = '') => `
      DROP TRIGGER IF EXISTS ${naam};
      CREATE TRIGGER ${naam} AFTER ${gebeurtenis} ON ${tabel}${wanneer ? ` WHEN ${wanneer}` : ''} BEGIN
        UPDATE ap_feed_rev SET n = n + 1;
        INSERT INTO ap_feed_state (slug, object_uri, rev, kind)
          ${extra || `VALUES (${slug}, ${uri}, (SELECT n FROM ap_feed_rev), '${kind}')`}
          ON CONFLICT(slug, object_uri) DO UPDATE
            SET rev = excluded.rev, kind = excluded.kind, at = CURRENT_TIMESTAMP;
      END;`;
    const joinPosts = (uri, kind) => `
          SELECT s.slug, ${uri}, (SELECT n FROM ap_feed_rev), '${kind}'
            FROM posts p JOIN sites s ON s.id = p.site_id`;
    db.exec([
      zet('trg_feed_tl_ins', 'INSERT', 'ap_timeline', 'NEW.slug', 'NEW.id', 'new'),
      zet('trg_feed_tl_upd', 'UPDATE OF content, media_json, nsfw, cw, url, poll_json, quote_json, embed_json', 'ap_timeline', 'NEW.slug', 'NEW.id', 'updated'),
      zet('trg_feed_tl_del', 'DELETE', 'ap_timeline', 'OLD.slug', 'OLD.id', 'deleted'),
      zet('trg_feed_mn_ins', 'INSERT', 'ap_mentions', 'NEW.slug', 'NEW.object_uri', 'new'),
      zet('trg_feed_mn_upd', 'UPDATE OF content, media_json, quote_json, embed_json', 'ap_mentions', 'NEW.slug', 'NEW.object_uri', 'updated'),
      zet('trg_feed_mn_del', 'DELETE', 'ap_mentions', 'OLD.slug', 'OLD.object_uri', 'deleted'),
      zet('trg_feed_ob_ins', 'INSERT', 'ap_outbox', 'NEW.site_slug', 'NEW.id', 'new'),
      zet('trg_feed_ob_upd', 'UPDATE OF content, attachments', 'ap_outbox', 'NEW.site_slug', 'NEW.id', 'updated'),
      zet('trg_feed_ob_del', 'DELETE', 'ap_outbox', 'OLD.site_slug', 'OLD.id', 'deleted'),
      // ap_interactions draagt geen slug: die hangt aan de POST. Vandaar de join,
      // en vandaar dat deze drie niet in de gewone vorm passen.
      //
      // De WHEN op kind='reply' is nodig omdat deze tabel ook likes en announces
      // draagt, en die schrijven object_uri = '' (zie recordInteraction). Zonder de
      // WHEN bumpte elke inkomende like de rev, werd elke wachter gewekt en kreeg
      // die de hele collectie opnieuw terwijl er niets aan veranderd was: precies de
      // kosten die de 304 moest wegnemen. Bovendien belandde er dan een rij op de
      // lege string in ap_feed_state, die feedChangesSince vervolgens uitdeelt.
      // De oude cursor filterde hier wel op kind; bij ap_timeline is dit ook gedaan
      // (de UPDATE OF sluit liked/boosted uit) en één tabel verder vergeten.
      zet('trg_feed_ia_ins', 'INSERT', 'ap_interactions', '', '', '', `${joinPosts('NEW.object_uri', 'new')} WHERE p.id = NEW.post_id`, "NEW.kind = 'reply'"),
      zet('trg_feed_ia_upd', 'UPDATE OF content, media_json, quote_json, embed_json', 'ap_interactions', '', '', '', `${joinPosts('NEW.object_uri', 'updated')} WHERE p.id = NEW.post_id`, "NEW.kind = 'reply'"),
      zet('trg_feed_ia_del', 'DELETE', 'ap_interactions', '', '', '', `${joinPosts('OLD.object_uri', 'deleted')} WHERE p.id = OLD.post_id`, "OLD.kind = 'reply'"),
    ].join('\n'));
  } catch (e) {
    // Niet fataal: zonder deze tabel valt het wachten terug op "altijd de tijd
    // volmaken", en dat is traag maar niet stuk.
    console.error('❌ feed-state triggers:', e.message);
  }
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
