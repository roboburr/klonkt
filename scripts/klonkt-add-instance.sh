#!/usr/bin/env bash
#
# Add a Klonkt instance. An instance is a data directory and an .env file; the
# code in /opt/klonkt is shared with every other instance and is not copied.
#
#     sudo bash scripts/klonkt-add-instance.sh <slug> <domain> [port]
#     sudo bash scripts/klonkt-add-instance.sh blog blog.example.com --no-caddy
#
# Leave the port out and a free one is chosen. Run klonkt-update once and every
# instance on the machine moves to the new code together.

set -euo pipefail

KLONKT_DIR="${KLONKT_DIR:-/opt/klonkt}"
KLONKT_USER="${KLONKT_USER:-klonkt}"
DATA_ROOT="${KLONKT_DATA_ROOT:-/var/lib/klonkt}"
NO_CADDY="${KLONKT_NO_CADDY:-}"
LANG_DEFAULT="${KLONKT_DEFAULT_LANG:-}"

SLUG=""; DOMAIN=""; PORT=""
for arg in "$@"; do
  case "$arg" in
    --no-caddy) NO_CADDY=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) if   [ -z "$SLUG" ];   then SLUG="$arg"
       elif [ -z "$DOMAIN" ]; then DOMAIN="$arg"
       elif [ -z "$PORT" ];   then PORT="$arg"
       fi ;;
  esac
done

say()  { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root (sudo)."
[ -n "$SLUG" ] && [ -n "$DOMAIN" ] || die "usage: $0 <slug> <domain> [port] [--no-caddy]"
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || die "slug must be lowercase letters, digits, dot, dash or underscore."

DATA_DIR="$DATA_ROOT/$SLUG"
ENV_FILE="$DATA_DIR/.env"

step "Preflight"
[ -d "$KLONKT_DIR" ] || die "no shared code at $KLONKT_DIR. Install Klonkt first."
[ -f "$KLONKT_DIR/src/config/paths.js" ] || die \
  "this build is too old to share one checkout between instances.
   Update first: klonkt-update"
id -u "$KLONKT_USER" >/dev/null 2>&1 || die "user $KLONKT_USER does not exist"
[ -e "$DATA_DIR" ] && die "$DATA_DIR already exists. Pick another slug."
[ -f /etc/systemd/system/klonkt@.service ] || {
  [ -f "$KLONKT_DIR/deploy/klonkt@.service" ] || die "missing $KLONKT_DIR/deploy/klonkt@.service"
  install -m 0644 "$KLONKT_DIR/deploy/klonkt@.service" /etc/systemd/system/klonkt@.service
  systemctl daemon-reload
  say "installed the systemd template (first instance on this machine)"
}

# Pick a port nobody is listening on and no other instance has claimed.
if [ -z "$PORT" ]; then
  for p in $(seq 3000 3099); do
    grep -rqs "^PORT=${p}$" "$DATA_ROOT"/*/.env && continue
    ss -ltnH "sport = :$p" 2>/dev/null | grep -q . && continue
    PORT="$p"; break
  done
  [ -n "$PORT" ] || die "no free port found in 3000-3099; pass one explicitly."
fi
say "slug $SLUG, domain $DOMAIN, port $PORT"

step "Creating $DATA_DIR"
mkdir -p "$DATA_DIR"

step "Writing .env"
SECRET="$(openssl rand -hex 32)"
{
  echo "NODE_ENV=production"
  echo "PORT=${PORT}"
  # Loopback only: the reverse proxy reaches it, the internet cannot bypass HTTPS.
  echo "HOST=127.0.0.1"
  echo "SESSION_SECRET=${SECRET}"
  echo "PUBLIC_BASE_URL=https://${DOMAIN}"
  echo "DATABASE_PATH=${DATA_DIR}/database.sqlite"
  echo "MEDIA_PATH=${DATA_DIR}/media"
  echo "AUDIO_PATH=${DATA_DIR}/audio"
  [ -n "$LANG_DEFAULT" ] && echo "KLONKT_DEFAULT_LANG=${LANG_DEFAULT}"
} > "$ENV_FILE"
say "random SESSION_SECRET, data paths under $DATA_DIR"

step "Ownership and permissions"
chown -R "$KLONKT_USER:$KLONKT_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"
chmod 600 "$ENV_FILE"
say "owned by $KLONKT_USER; .env readable only by that user"

step "Starting klonkt@$SLUG"
systemctl enable --now "klonkt@$SLUG"
sleep 3
systemctl is-active --quiet "klonkt@$SLUG" || {
  echo; journalctl -u "klonkt@$SLUG" -n 30 --no-pager || true
  die "klonkt@$SLUG did not start."
}
curl -fsS --max-time 8 -o /dev/null "http://127.0.0.1:${PORT}/" \
  && say "responding on 127.0.0.1:${PORT}" \
  || say "WARNING: no answer yet on 127.0.0.1:${PORT}; check journalctl -u klonkt@$SLUG -f"

if [ -z "$NO_CADDY" ] && command -v caddy >/dev/null 2>&1; then
  step "Caddy"
  CADDY=/etc/caddy/Caddyfile
  if grep -q "^${DOMAIN} {" "$CADDY" 2>/dev/null; then
    say "a block for ${DOMAIN} already exists, left untouched"
  else
    cp "$CADDY" "${CADDY}.bak.$(date +%s)" 2>/dev/null || true
    printf '\n%s {\n    reverse_proxy 127.0.0.1:%s\n    encode gzip zstd\n}\n' "$DOMAIN" "$PORT" >> "$CADDY"
    caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 \
      || die "Caddy config invalid after adding ${DOMAIN} — check $CADDY (a .bak was made)"
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
    say "serving ${DOMAIN}"
  fi
fi

cat <<EOF

Instance ready.

  data   $DATA_DIR
  unit   klonkt@$SLUG
  port   127.0.0.1:$PORT
  code   $KLONKT_DIR  (shared with every other instance)

Next: open https://${DOMAIN}/auth/register and create the admin account.

  status   systemctl status klonkt@$SLUG
  logs     journalctl -u klonkt@$SLUG -f
  update   klonkt-update          # updates the code once, restarts all instances
  backup   $DATA_DIR              # this directory is the whole instance
EOF
