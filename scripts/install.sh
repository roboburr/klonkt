#!/usr/bin/env bash
#
# Klonkt — installer for a Debian/Ubuntu VPS.
# Installs Node 20, Caddy (automatic HTTPS) and Klonkt as a systemd service.
#
# Safe on a server that ALREADY runs things: it won't upgrade your system Node,
# auto-picks a free port, and skips Caddy if a webserver/reverse-proxy is already
# listening on port 80/443 (you then get instructions to put Klonkt behind your
# own proxy).
#
# Usage (as root), non-interactive:
#   curl -fsSL https://raw.githubusercontent.com/roboburr/klonkt/main/scripts/install.sh \
#     | sudo bash -s -- --domain klonkt.example.com
# Or interactively from a downloaded file:
#   sudo bash install.sh
#
# Re-running on the same server = update (git pull + restart).
# Fully isolated alternative: Docker (see docker-compose.yml in the repo).
#
set -euo pipefail

# ── Settings (override via env var or flag) ────────────────────────────────
KLONKT_REPO="${KLONKT_REPO:-https://github.com/roboburr/klonkt.git}"
KLONKT_BRANCH="${KLONKT_BRANCH:-main}"
KLONKT_DIR="${KLONKT_DIR:-/opt/klonkt}"
KLONKT_USER="${KLONKT_USER:-klonkt}"
KLONKT_PORT="${KLONKT_PORT:-3000}"
KLONKT_DOMAIN="${KLONKT_DOMAIN:-}"
KLONKT_LANG="${KLONKT_DEFAULT_LANG:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"
NO_CADDY="${KLONKT_NO_CADDY:-}"     # set to 1 to NEVER install Caddy (own proxy)
NODE_FORCE="${NODE_FORCE:-}"        # set to 1 to (re)install system Node anyway
PORT_EXPLICIT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) KLONKT_DOMAIN="$2"; shift 2;;
    --repo)   KLONKT_REPO="$2";   shift 2;;
    --branch) KLONKT_BRANCH="$2"; shift 2;;
    --dir)    KLONKT_DIR="$2";    shift 2;;
    --port)   KLONKT_PORT="$2"; PORT_EXPLICIT=1; shift 2;;
    --lang)   KLONKT_LANG="$2";  shift 2;;
    --no-caddy) NO_CADDY=1; shift;;
    --force-node) NODE_FORCE=1; shift;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

log()  { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
as_klonkt() { runuser -u "$KLONKT_USER" -- env HOME="$KLONKT_DIR" "$@"; }
port_busy() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}$"; }

[ "$(id -u)" = 0 ] || die "Run this as root (sudo bash install.sh)."
command -v apt-get >/dev/null || die "Debian/Ubuntu only (apt). On other systems use the Docker route."

if [ -z "$KLONKT_DOMAIN" ]; then
  read -rp "Domain for Klonkt (e.g. klonkt.example.com): " KLONKT_DOMAIN </dev/tty || true
fi
[ -n "$KLONKT_DOMAIN" ] || die "No domain given (--domain or KLONKT_DOMAIN)."
case "$KLONKT_REPO" in
  *OWNER/*) die "Set the real repo URL first: --repo https://github.com/<you>/klonkt.git (or KLONKT_REPO=...).";;
esac

export DEBIAN_FRONTEND=noninteractive

# ── Preflight: see what's already running, adapt instead of clobbering ──────
log "Preflight (what's already running?)…"
apt-get update -y >/dev/null
apt-get install -y iproute2 >/dev/null 2>&1 || true

# Port: busy? With --port → error. Otherwise auto-pick a free one.
if port_busy "$KLONKT_PORT"; then
  if [ "$PORT_EXPLICIT" = 1 ]; then
    die "Port ${KLONKT_PORT} is already in use. Pick a free port with --port."
  fi
  picked=""
  for p in $(seq "$KLONKT_PORT" $((KLONKT_PORT+30))); do
    port_busy "$p" || { picked="$p"; break; }
  done
  [ -n "$picked" ] || die "No free port found near ${KLONKT_PORT}. Provide one with --port."
  warn "port ${KLONKT_PORT} busy → Klonkt uses ${picked}"
  KLONKT_PORT="$picked"
else
  ok "port ${KLONKT_PORT} free"
fi

# Webserver on 80/443 that isn't Caddy? → skip Caddy, own-proxy mode.
FOREIGN_PROXY=0
if [ -z "$NO_CADDY" ] && command -v ss >/dev/null 2>&1; then
  if ss -ltnpH 2>/dev/null | grep -E '[:.](80|443) ' | grep -viq 'caddy'; then
    NO_CADDY=1; FOREIGN_PROXY=1
    warn "something is already listening on port 80/443 (not Caddy) → NOT installing Caddy; you'll get proxy instructions"
  fi
fi

# ── Node: respect an existing version, don't silently upgrade ──────────────
log "Node ${NODE_MAJOR}.x…"
if command -v node >/dev/null 2>&1 && [ -z "$NODE_FORCE" ]; then
  CUR="$(node -v | sed 's/v//;s/\..*//')"
  if [ "$CUR" -lt "$NODE_MAJOR" ]; then
    die "Node $(node -v) is already installed on this server; Klonkt needs ≥${NODE_MAJOR}.
   I will NOT auto-upgrade your system Node — that could break other apps.
   Options: (a) use the Docker route (own Node, touches nothing), or
            (b) upgrade Node yourself, or (c) force with NODE_FORCE=1 (at your own risk)."
  fi
  ok "using existing node $(node -v)"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  ok "node $(node -v) installed"
fi

log "Other packages…"
apt-get install -y curl ca-certificates git gnupg openssl build-essential python3
apt-get install -y webp >/dev/null 2>&1 || true   # cwebp = image→WebP (optional)
ok "base packages"

if [ -z "$NO_CADDY" ]; then
  log "Caddy (reverse proxy + auto-HTTPS)…"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  ok "caddy present"
fi

log "Service user '${KLONKT_USER}'…"
id -u "$KLONKT_USER" >/dev/null 2>&1 || useradd --system --home-dir "$KLONKT_DIR" --shell /usr/sbin/nologin "$KLONKT_USER"
ok "user"

log "Fetching Klonkt source…"
if [ -d "$KLONKT_DIR/.git" ]; then
  git -C "$KLONKT_DIR" remote set-url origin "$KLONKT_REPO"
  git -C "$KLONKT_DIR" fetch --depth 1 origin "$KLONKT_BRANCH"
  git -C "$KLONKT_DIR" reset --hard "origin/$KLONKT_BRANCH"
else
  [ -e "$KLONKT_DIR" ] && [ -n "$(ls -A "$KLONKT_DIR" 2>/dev/null)" ] && die "$KLONKT_DIR already exists and is not a git checkout. Pick --dir, or clean it up."
  mkdir -p "$KLONKT_DIR"
  git clone --depth 1 --branch "$KLONKT_BRANCH" "$KLONKT_REPO" "$KLONKT_DIR"
fi
mkdir -p "$KLONKT_DIR/storage/media" "$KLONKT_DIR/storage/audio"
chown -R "$KLONKT_USER:$KLONKT_USER" "$KLONKT_DIR"
ok "code in $KLONKT_DIR"

log "Installing dependencies (npm ci)…"
as_klonkt bash -c "cd '$KLONKT_DIR' && npm ci --omit=dev"
ok "node_modules"

log ".env…"
ENV="$KLONKT_DIR/.env"
if [ ! -f "$ENV" ]; then
  SECRET="$(openssl rand -hex 32)"
  {
    echo "NODE_ENV=production"
    echo "PORT=${KLONKT_PORT}"
    echo "SESSION_SECRET=${SECRET}"
    echo "DATABASE_PATH=./storage/database.sqlite"
    echo "MEDIA_PATH=./storage/media"
    echo "AUDIO_PATH=./storage/audio"
    echo "PUBLIC_BASE_URL=https://${KLONKT_DOMAIN}"
    [ -n "$KLONKT_LANG" ] && echo "KLONKT_DEFAULT_LANG=${KLONKT_LANG}"
  } > "$ENV"
  chown "$KLONKT_USER:$KLONKT_USER" "$ENV"; chmod 600 "$ENV"
  ok "new .env (random SESSION_SECRET)"
else
  # sync the port in an existing .env with the chosen port
  if grep -q '^PORT=' "$ENV"; then sed -i "s/^PORT=.*/PORT=${KLONKT_PORT}/" "$ENV"; fi
  ok "kept existing .env (port synced)"
fi

log "systemd service…"
NODE_BIN="$(command -v node)"
cat > /etc/systemd/system/klonkt.service <<EOF
[Unit]
Description=Klonkt
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${KLONKT_USER}
WorkingDirectory=${KLONKT_DIR}
ExecStart=${NODE_BIN} src/server.js
Environment=NODE_ENV=production
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now klonkt
ok "klonkt.service running on 127.0.0.1:${KLONKT_PORT}"

if [ -z "$NO_CADDY" ]; then
  log "Caddy config for ${KLONKT_DOMAIN}…"
  CADDY=/etc/caddy/Caddyfile
  SITE_BLOCK="${KLONKT_DOMAIN} {
    reverse_proxy 127.0.0.1:${KLONKT_PORT}
    encode gzip zstd
}"
  touch "$CADDY"
  if grep -q '/usr/share/caddy' "$CADDY"; then
    cp "$CADDY" "${CADDY}.bak.$(date +%s)"
    printf '%s\n' "$SITE_BLOCK" > "$CADDY"
  elif ! grep -q "^${KLONKT_DOMAIN} {" "$CADDY"; then
    printf '\n%s\n' "$SITE_BLOCK" >> "$CADDY"
  fi
  caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 || die "Caddy config invalid — check $CADDY"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  ok "caddy serving ${KLONKT_DOMAIN}"
fi

log "Update command 'klonkt-update'…"
cat > /usr/local/bin/klonkt-update <<EOF
#!/usr/bin/env bash
set -euo pipefail
D="${KLONKT_DIR}"
B=\$(runuser -u ${KLONKT_USER} -- git -C "\$D" rev-parse HEAD 2>/dev/null || true)
runuser -u ${KLONKT_USER} -- git -C "\$D" fetch --depth 1 origin ${KLONKT_BRANCH}
runuser -u ${KLONKT_USER} -- git -C "\$D" reset --hard origin/${KLONKT_BRANCH}
A=\$(runuser -u ${KLONKT_USER} -- git -C "\$D" rev-parse HEAD)
if ! runuser -u ${KLONKT_USER} -- git -C "\$D" diff --quiet "\$B" "\$A" -- package-lock.json 2>/dev/null; then
  runuser -u ${KLONKT_USER} -- env HOME="\$D" bash -c "cd '\$D' && npm ci --omit=dev"
fi
systemctl restart klonkt
echo "Klonkt updated (\$A) + restarted."
EOF
chmod +x /usr/local/bin/klonkt-update
ok "klonkt-update"

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Klonkt is running! 🎉"
echo
if [ -n "$NO_CADDY" ]; then
  echo "  Klonkt listens on:  http://127.0.0.1:${KLONKT_PORT}"
  if [ "$FOREIGN_PROXY" = 1 ]; then
    echo "  A webserver is already running on 80/443 — put Klonkt behind it."
  fi
  echo "  Example nginx:"
  echo "      location / { proxy_pass http://127.0.0.1:${KLONKT_PORT}; proxy_set_header Host \$host;"
  echo "                   proxy_set_header X-Forwarded-Proto \$scheme; }"
  echo "  Example Caddy:"
  echo "      ${KLONKT_DOMAIN} { reverse_proxy 127.0.0.1:${KLONKT_PORT} }"
else
  echo "  • Open your site:  https://${KLONKT_DOMAIN}"
fi
echo "  • First run:       go to /auth/register and create your admin account."
echo
echo "  Manage:  systemctl status klonkt · journalctl -u klonkt -f · klonkt-update"
echo "  Lost password: cd ${KLONKT_DIR} && runuser -u ${KLONKT_USER} -- env HOME=${KLONKT_DIR} npm run reset-admin"
echo
echo "  DNS: make sure A + AAAA of ${KLONKT_DOMAIN} point to this server."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
