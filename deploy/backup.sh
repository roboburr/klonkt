#!/usr/bin/env bash
#
# PrutCMS v10 — nightly backup script.
#
# Snapshots:
#   • SQLite database (uses .backup so it's safe while the app is running)
#   • storage/audio/        (uploaded MP3s — files outside /media for security)
#   • storage/media/        (avatars, audio covers — public files)
#   • storage/.audio-secret (HMAC secret — needed to verify old signed URLs)
#
# Output: a single tar.gz per run in $BACKUP_DIR, named by timestamp.
# Rotation: keeps the last $KEEP_DAYS dumps, prunes older.
#
# Recommended cron:
#   0 3 * * * /home/robin/prutcms/deploy/backup.sh >> /home/robin/prutcms/logs/backup.log 2>&1

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/home/robin/prutcms}"
BACKUP_DIR="${BACKUP_DIR:-/home/robin/backups/prutcms}"
KEEP_DAYS="${KEEP_DAYS:-14}"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

# ── DB snapshot via sqlite3 .backup (consistent under WAL) ────────
DB_FILE="$APP_DIR/storage/database.sqlite"
DB_SNAPSHOT="$BACKUP_DIR/db-$TS.sqlite"
if [ -f "$DB_FILE" ]; then
    sqlite3 "$DB_FILE" ".backup '$DB_SNAPSHOT'"
else
    echo "WARN: $DB_FILE not found, skipping DB backup" >&2
fi

# ── Tar the snapshot + storage subdirs ────────────────────────────
ARCHIVE="$BACKUP_DIR/prutcms-$TS.tar.gz"
tar -czf "$ARCHIVE" \
    -C "$BACKUP_DIR" "$(basename "$DB_SNAPSHOT")" \
    -C "$APP_DIR/storage" \
        $( [ -d "$APP_DIR/storage/audio"        ] && echo audio        ) \
        $( [ -d "$APP_DIR/storage/media"        ] && echo media        ) \
        $( [ -f "$APP_DIR/storage/.audio-secret" ] && echo .audio-secret )

# Remove the loose db-XXX.sqlite (it's inside the tarball now)
rm -f "$DB_SNAPSHOT"

# ── Rotation ───────────────────────────────────────────────────────
find "$BACKUP_DIR" -type f -name 'prutcms-*.tar.gz' -mtime "+$KEEP_DAYS" -delete

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
echo "[$TS] backup OK: $ARCHIVE ($SIZE)"
