-- PrutFolio v1 — initial schema
-- Forked from PrutCMS v9 (PHP, file-based) → SQLite/Node
-- Complete schema with v9 features (Prutter, Forum, Audio, Themes) + v10 CRDT

-- ==================== USERS ====================
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'member', -- member, admin, god
    avatar_url TEXT,
    bio TEXT,
    theme TEXT DEFAULT 'dark', -- dark, light
    palette TEXT DEFAULT 'sage', -- sage, paper, ocean, forest, stone, midnight, sunset, cream
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==================== SITES ====================
CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    tagline TEXT,
    owner_id TEXT NOT NULL,
    parent_site_id TEXT,
    
    -- v9 config fields
    language TEXT DEFAULT 'nl',
    author TEXT,
    palette TEXT DEFAULT 'sage',
    accent TEXT DEFAULT '#c2410c',
    theme_override TEXT,
    
    -- Social/SEO
    social_title TEXT,
    social_description TEXT,
    social_image TEXT,
    og_image_default TEXT,
    default_cover TEXT,
    default_description TEXT,
    canonical TEXT,
    
    -- Verification metas
    google_verification TEXT,
    bing_verification TEXT,
    pinterest_verification TEXT,
    yandex_verification TEXT,
    og_locale TEXT,
    facebook_app_id TEXT,
    
    -- Customization
    custom_css TEXT,
    custom_head_html TEXT,
    custom_foot_html TEXT,
    title_template TEXT DEFAULT '{title} — {site}',
    
    -- Settings
    is_public INTEGER DEFAULT 1,
    closed_circle_mode INTEGER DEFAULT 0,
    robots_index INTEGER DEFAULT 1,
    require_login_to_comment INTEGER DEFAULT 0,
    enable_audio_player INTEGER DEFAULT 1,
    profile_photo TEXT,

    origin_server TEXT DEFAULT 'local',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (owner_id) REFERENCES users(id),
    FOREIGN KEY (parent_site_id) REFERENCES sites(id)
);

-- ==================== SITE MEMBERS ====================
CREATE TABLE IF NOT EXISTS site_members (
    site_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (site_id, user_id),
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ==================== POSTS ====================
CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    author_id TEXT NOT NULL,
    title TEXT,
    content TEXT,
    excerpt TEXT,
    status TEXT DEFAULT 'draft',
    cover_image_url TEXT,
    pinned INTEGER DEFAULT 0,
    type TEXT DEFAULT 'post',
    tags TEXT,
    published_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    yjs_binary BLOB,
    origin_server TEXT DEFAULT 'local',
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    UNIQUE (site_id, slug)
);

-- ==================== COMMENTS (FORUM) ====================
CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    parent_comment_id TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    yjs_binary BLOB,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (author_id) REFERENCES users(id),
    FOREIGN KEY (parent_comment_id) REFERENCES comments(id)
);

-- ==================== PRUTTER (DM SYSTEM) ====================
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_a_id TEXT NOT NULL,
    user_b_id TEXT NOT NULL,
    site_id TEXT,
    last_message_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_a_id) REFERENCES users(id),
    FOREIGN KEY (user_b_id) REFERENCES users(id),
    FOREIGN KEY (site_id) REFERENCES sites(id),
    UNIQUE (user_a_id, user_b_id, site_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    content TEXT NOT NULL,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (author_id) REFERENCES users(id)
);

-- ==================== MEDIA ====================
CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- ==================== AUDIO TRACKS ====================
CREATE TABLE IF NOT EXISTS audio_tracks (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    duration INTEGER,
    media_id TEXT,
    position INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (media_id) REFERENCES media(id)
);

-- ==================== PLAYLISTS ====================
-- First-class playlist entity (from v9). Posts reference playlists by id;
-- editing a playlist propagates to every post that embeds it via [[playlist:id]].
-- `kind` distinguishes display style: 'album' (numbered list) vs 'playlist' (per-track thumbnails).
CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,                    -- slug-style id, e.g. "ai-covers"
    site_id TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT,
    year INTEGER,
    cover_url TEXT,
    kind TEXT DEFAULT 'album',              -- 'album' | 'playlist'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (site_id) REFERENCES sites(id)
);

-- Junction table — preserves track ordering via `position`.
-- Composite PK prevents the same track being listed twice in the same playlist
-- but allows the same track to appear in many playlists.
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

-- ==================== NOTIFICATIONS ====================
CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT,
    title TEXT,
    message TEXT,
    link TEXT,
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- ==================== SEARCH (FTS5) ====================
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    content,
    title,
    author,
    post_id UNINDEXED
);

-- ==================== FEDERATION ====================
CREATE TABLE IF NOT EXISTS federation_log (
    id TEXT PRIMARY KEY,
    entity_type TEXT,
    entity_id TEXT,
    origin_server TEXT,
    action TEXT,
    yjs_update BLOB,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==================== SESSIONS ====================
CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT,
    expiresAt DATETIME
);

-- ==================== INDEXES ====================
CREATE INDEX IF NOT EXISTS idx_posts_site ON posts(site_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
