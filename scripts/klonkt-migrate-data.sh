#!/usr/bin/env bash
#
# Move an existing Klonkt install to the split layout:
#
#     /opt/klonkt/                shared code, read-only at runtime
#     /var/lib/klonkt/<slug>/     this instance's data and .env
#
# Before, an instance kept its database, uploads and .env inside the checkout.
# That made the code directory undeletable (it held live user data), made
# backups awkward, and meant a second instance needed a second copy of the code.
#
# Run as root on the server. Safe to re-run: it stops at the first step that is
# already done rather than moving anything twice.
#
#     sudo bash scripts/klonkt-migrate-data.sh <slug>
#     sudo bash scripts/klonkt-migrate-data.sh <slug> --dry-run
#
# The slug names the instance and nothing else: it is the directory under
# /var/lib/klonkt and the systemd instance name (klonkt@<slug>).

set -euo pipefail

KLONKT_DIR="${KLONKT_DIR:-/opt/klonkt}"
KLONKT_USER="${KLONKT_USER:-klonkt}"
DATA_ROOT="${KLONKT_DATA_ROOT:-/var/lib/klonkt}"
OLD_UNIT="klonkt.service"

SLUG=""
DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) SLUG="$arg" ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*"; else eval "$@"; fi; }

[ "$(id -u)" = 0 ] || die "run this as root (sudo)."
[ -n "$SLUG" ]      || die "usage: $0 <slug> [--dry-run]   e.g. $0 boiert"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "slug must be lowercase letters, digits, dot, dash or underscore."

DATA_DIR="$DATA_ROOT/$SLUG"
ENV_OLD="$KLONKT_DIR/.env"
ENV_NEW="$DATA_DIR/.env"

step "Preflight"
[ -d "$KLONKT_DIR" ]  || die "no install at $KLONKT_DIR"
[ -f "$ENV_OLD" ] || [ -f "$ENV_NEW" ] || die "no .env at $ENV_OLD (already migrated elsewhere?)"
id -u "$KLONKT_USER" >/dev/null 2>&1 || die "user $KLONKT_USER does not exist"

# The split only works on code where every media subdirectory derives from
# MEDIA_PATH. On older code the subdirectories fall back into the checkout, so
# the app would quietly recreate storage/ next to the code and uploads would
# land there.
[ -f "$KLONKT_DIR/src/config/paths.js" ] || die \
  "this build is too old for the split layout: src/config/paths.js is missing.
   Update first (git pull in $KLONKT_DIR), then run this again."
say "code at $KLONKT_DIR supports MEDIA_PATH-derived subdirectories"

if [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  die "$DATA_DIR already exists and is not empty. Remove it or pick another slug."
fi
say "target $DATA_DIR is free"
[ "$DRY" = 1 ] && say "DRY RUN: nothing will be changed"

step "Stopping the service"
if systemctl is-active --quiet "$OLD_UNIT"; then
  run "systemctl stop $OLD_UNIT"
  say "stopped $OLD_UNIT (SQLite checkpoints its write-ahead log on shutdown)"
else
  say "$OLD_UNIT was not running"
fi

step "Creating the data directory"
run "mkdir -p '$DATA_DIR'"

step "Moving data out of the checkout"
if [ -d "$KLONKT_DIR/storage" ]; then
  say "found $(find "$KLONKT_DIR/storage" -type f 2>/dev/null | wc -l) files in storage/ ($(du -sh "$KLONKT_DIR/storage" 2>/dev/null | cut -f1))"
  # Everything, including database.sqlite plus its -wal and -shm siblings.
  run "shopt -s dotglob nullglob; for f in '$KLONKT_DIR/storage/'*; do mv \"\$f\" '$DATA_DIR/'; done"
  run "rmdir '$KLONKT_DIR/storage' 2>/dev/null || true"
  say "moved to $DATA_DIR"
else
  say "no storage/ directory (already moved?)"
fi

if [ -f "$ENV_OLD" ]; then
  run "mv '$ENV_OLD' '$ENV_NEW'"
  say "moved .env to $ENV_NEW"
fi

step "Pointing the data paths at the new location"
# Replace when present, append when absent, so this works regardless of which
# variables the original install wrote.
set_env() {
  local key="$1" val="$2"
  if [ "$DRY" = 1 ]; then printf '  [dry-run] %s=%s\n' "$key" "$val"; return; fi
  if grep -q "^${key}=" "$ENV_NEW" 2>/dev/null; then
    sed -i "s#^${key}=.*#${key}=${val}#" "$ENV_NEW"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_NEW"
  fi
  printf '  %s=%s\n' "$key" "$val"
}
set_env DATABASE_PATH "$DATA_DIR/database.sqlite"
set_env MEDIA_PATH    "$DATA_DIR/media"
set_env AUDIO_PATH    "$DATA_DIR/audio"

step "Ownership and permissions"
run "chown -R '$KLONKT_USER:$KLONKT_USER' '$DATA_DIR'"
run "chmod 750 '$DATA_DIR'"
run "chmod 600 '$ENV_NEW'"
say "data owned by $KLONKT_USER, .env readable only by that user"

step "Installing the systemd template"
if [ -f "$KLONKT_DIR/deploy/klonkt@.service" ]; then
  run "install -m 0644 '$KLONKT_DIR/deploy/klonkt@.service' /etc/systemd/system/klonkt@.service"
  say "installed /etc/systemd/system/klonkt@.service"
else
  die "template not found at $KLONKT_DIR/deploy/klonkt@.service"
fi
run "systemctl daemon-reload"

step "Switching to klonkt@$SLUG"
if systemctl is-enabled --quiet "$OLD_UNIT" 2>/dev/null; then
  run "systemctl disable --now $OLD_UNIT"
  say "disabled $OLD_UNIT (file kept, so you can roll back)"
fi
run "systemctl enable --now 'klonkt@$SLUG'"

step "Verifying"
if [ "$DRY" = 1 ]; then
  say "dry run: skipping verification"
  exit 0
fi
sleep 3
systemctl is-active --quiet "klonkt@$SLUG" || {
  echo
  journalctl -u "klonkt@$SLUG" -n 30 --no-pager || true
  die "klonkt@$SLUG did not start. Roll back with: systemctl enable --now $OLD_UNIT"
}
say "klonkt@$SLUG is running"

PORT="$(grep -m1 '^PORT=' "$ENV_NEW" | cut -d= -f2- | tr -d '\r')"
if [ -n "$PORT" ]; then
  if curl -fsS --max-time 8 -o /dev/null "http://127.0.0.1:${PORT}/"; then
    say "responding on 127.0.0.1:${PORT}"
  else
    say "WARNING: no answer on 127.0.0.1:${PORT} yet; check: journalctl -u klonkt@$SLUG -f"
  fi
fi

if [ -e "$KLONKT_DIR/storage" ]; then
  say "WARNING: $KLONKT_DIR/storage came back. That means this build still writes"
  say "         next to its code. Report it; do not delete the directory."
else
  say "the checkout no longer holds user data"
fi

cat <<EOF

Done. This instance now looks like:

  code   $KLONKT_DIR              shared, replaceable, no user data
  data   $DATA_DIR    database, uploads and .env
  unit   klonkt@$SLUG

Back up $DATA_DIR and you have the whole instance.
Add another instance with: klonkt-add-instance.sh <slug> <domain> <port>
EOF
