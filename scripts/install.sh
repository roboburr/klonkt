#!/usr/bin/env bash
#
# Klonkt — installer voor een Debian/Ubuntu VPS.
# Installeert Node 20, Caddy (automatische HTTPS) en Klonkt als systemd-service.
#
# Veilig op een server die AL iets draait: upgradet je systeem-Node niet,
# kiest automatisch een vrije poort, en slaat Caddy over als er al een
# webserver/reverse-proxy op poort 80/443 luistert (dan krijg je instructies
# om Klonkt achter je eigen proxy te zetten).
#
# Gebruik (als root), niet-interactief:
#   curl -fsSL https://raw.githubusercontent.com/roboburr/klonkt/main/scripts/install.sh \
#     | sudo bash -s -- --domain klonkt.voorbeeld.nl
# Of interactief vanaf een gedownload bestand:
#   sudo bash install.sh
#
# Opnieuw draaien op dezelfde server = bijwerken (git pull + herstart).
# Volledig geïsoleerd alternatief: Docker (zie docker-compose.yml in de repo).
#
set -euo pipefail

# ── Instellingen (override via env-variabele of vlag) ──────────────────────
KLONKT_REPO="${KLONKT_REPO:-https://github.com/roboburr/klonkt.git}"  # TODO: echte GitHub-URL
KLONKT_BRANCH="${KLONKT_BRANCH:-main}"
KLONKT_DIR="${KLONKT_DIR:-/opt/klonkt}"
KLONKT_USER="${KLONKT_USER:-klonkt}"
KLONKT_PORT="${KLONKT_PORT:-3000}"
KLONKT_DOMAIN="${KLONKT_DOMAIN:-}"
KLONKT_LANG="${KLONKT_DEFAULT_LANG:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"
NO_CADDY="${KLONKT_NO_CADDY:-}"     # zet op 1 om Caddy NOOIT te installeren (eigen proxy)
NODE_FORCE="${NODE_FORCE:-}"        # zet op 1 om systeem-Node tóch te (her)installeren
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
    *) echo "Onbekende optie: $1" >&2; exit 1;;
  esac
done

log()  { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
as_klonkt() { runuser -u "$KLONKT_USER" -- env HOME="$KLONKT_DIR" "$@"; }
port_busy() { ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}$"; }

[ "$(id -u)" = 0 ] || die "Draai dit als root (sudo bash install.sh)."
command -v apt-get >/dev/null || die "Alleen Debian/Ubuntu (apt). Gebruik op andere systemen de Docker-route."

if [ -z "$KLONKT_DOMAIN" ]; then
  read -rp "Domein voor Klonkt (bv. klonkt.voorbeeld.nl): " KLONKT_DOMAIN </dev/tty || true
fi
[ -n "$KLONKT_DOMAIN" ] || die "Geen domein opgegeven (--domain of KLONKT_DOMAIN)."
case "$KLONKT_REPO" in
  *OWNER/*) die "Zet eerst de echte repo-URL: --repo https://github.com/<jij>/klonkt.git (of KLONKT_REPO=...).";;
esac

export DEBIAN_FRONTEND=noninteractive

# ── Preflight: kijk wat er al draait, pas je aan i.p.v. clobberen ──────────
log "Preflight (wat draait er al?)…"
apt-get update -y >/dev/null
apt-get install -y iproute2 >/dev/null 2>&1 || true

# Poort: bezet? Bij --port → fout. Anders automatisch een vrije kiezen.
if port_busy "$KLONKT_PORT"; then
  if [ "$PORT_EXPLICIT" = 1 ]; then
    die "Poort ${KLONKT_PORT} is al in gebruik. Kies een vrije poort met --port."
  fi
  picked=""
  for p in $(seq "$KLONKT_PORT" $((KLONKT_PORT+30))); do
    port_busy "$p" || { picked="$p"; break; }
  done
  [ -n "$picked" ] || die "Geen vrije poort gevonden rond ${KLONKT_PORT}. Geef er een met --port."
  warn "poort ${KLONKT_PORT} bezet → Klonkt gebruikt ${picked}"
  KLONKT_PORT="$picked"
else
  ok "poort ${KLONKT_PORT} vrij"
fi

# Webserver op 80/443 die niet Caddy is? → Caddy overslaan, eigen-proxy-modus.
FOREIGN_PROXY=0
if [ -z "$NO_CADDY" ] && command -v ss >/dev/null 2>&1; then
  if ss -ltnpH 2>/dev/null | grep -E '[:.](80|443) ' | grep -viq 'caddy'; then
    NO_CADDY=1; FOREIGN_PROXY=1
    warn "er luistert al iets op poort 80/443 (geen Caddy) → ik installeer Caddy NIET en geef je proxy-instructies"
  fi
fi

# ── Node: bestaande versie respecteren, niet stilletjes upgraden ──────────
log "Node ${NODE_MAJOR}.x…"
if command -v node >/dev/null 2>&1 && [ -z "$NODE_FORCE" ]; then
  CUR="$(node -v | sed 's/v//;s/\..*//')"
  if [ "$CUR" -lt "$NODE_MAJOR" ]; then
    die "Er staat al Node $(node -v) op deze server; Klonkt heeft ≥${NODE_MAJOR} nodig.
   Ik upgrade je systeem-Node NIET automatisch — dat kan andere apps breken.
   Opties: (a) gebruik de Docker-route (eigen Node, raakt niets aan), of
           (b) upgrade Node zelf, of (c) forceer met NODE_FORCE=1 (eigen risico)."
  fi
  ok "bestaande node $(node -v) wordt gebruikt"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  ok "node $(node -v) geïnstalleerd"
fi

log "Overige pakketten…"
apt-get install -y curl ca-certificates git gnupg openssl build-essential python3
apt-get install -y webp >/dev/null 2>&1 || true   # cwebp = afbeelding→WebP (optioneel)
ok "basis-pakketten"

if [ -z "$NO_CADDY" ]; then
  log "Caddy (reverse proxy + auto-HTTPS)…"
  if ! command -v caddy >/dev/null 2>&1; then
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  ok "caddy aanwezig"
fi

log "Service-gebruiker '${KLONKT_USER}'…"
id -u "$KLONKT_USER" >/dev/null 2>&1 || useradd --system --home-dir "$KLONKT_DIR" --shell /usr/sbin/nologin "$KLONKT_USER"
ok "gebruiker"

log "Klonkt-broncode ophalen…"
if [ -d "$KLONKT_DIR/.git" ]; then
  git -C "$KLONKT_DIR" remote set-url origin "$KLONKT_REPO"
  git -C "$KLONKT_DIR" fetch --depth 1 origin "$KLONKT_BRANCH"
  git -C "$KLONKT_DIR" reset --hard "origin/$KLONKT_BRANCH"
else
  [ -e "$KLONKT_DIR" ] && [ -n "$(ls -A "$KLONKT_DIR" 2>/dev/null)" ] && die "$KLONKT_DIR bestaat al en is geen git-checkout. Kies --dir, of ruim 'm op."
  mkdir -p "$KLONKT_DIR"
  git clone --depth 1 --branch "$KLONKT_BRANCH" "$KLONKT_REPO" "$KLONKT_DIR"
fi
mkdir -p "$KLONKT_DIR/storage/media" "$KLONKT_DIR/storage/audio"
chown -R "$KLONKT_USER:$KLONKT_USER" "$KLONKT_DIR"
ok "code in $KLONKT_DIR"

log "Dependencies installeren (npm ci)…"
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
  ok "nieuwe .env (willekeurige SESSION_SECRET)"
else
  # poort in bestaande .env synchroniseren met de gekozen poort
  if grep -q '^PORT=' "$ENV"; then sed -i "s/^PORT=.*/PORT=${KLONKT_PORT}/" "$ENV"; fi
  ok "bestaande .env behouden (poort gesynchroniseerd)"
fi

log "systemd-service…"
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
ok "klonkt.service draait op 127.0.0.1:${KLONKT_PORT}"

if [ -z "$NO_CADDY" ]; then
  log "Caddy-config voor ${KLONKT_DOMAIN}…"
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
  caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 || die "Caddy-config ongeldig — controleer $CADDY"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  ok "caddy serveert ${KLONKT_DOMAIN}"
fi

log "Update-commando 'klonkt-update'…"
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
echo "Klonkt bijgewerkt (\$A) + herstart."
EOF
chmod +x /usr/local/bin/klonkt-update
ok "klonkt-update"

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Klonkt draait! 🎉"
echo
if [ -n "$NO_CADDY" ]; then
  echo "  Klonkt luistert op:  http://127.0.0.1:${KLONKT_PORT}"
  if [ "$FOREIGN_PROXY" = 1 ]; then
    echo "  Er draait al een webserver op 80/443 — zet Klonkt erachter."
  fi
  echo "  Voorbeeld nginx:"
  echo "      location / { proxy_pass http://127.0.0.1:${KLONKT_PORT}; proxy_set_header Host \$host;"
  echo "                   proxy_set_header X-Forwarded-Proto \$scheme; }"
  echo "  Voorbeeld Caddy:"
  echo "      ${KLONKT_DOMAIN} { reverse_proxy 127.0.0.1:${KLONKT_PORT} }"
else
  echo "  • Open je site:   https://${KLONKT_DOMAIN}"
fi
echo "  • Eerste keer:    ga naar /auth/register en maak je beheerdersaccount aan."
echo
echo "  Beheer:  systemctl status klonkt · journalctl -u klonkt -f · klonkt-update"
echo "  Wachtwoord kwijt: cd ${KLONKT_DIR} && runuser -u ${KLONKT_USER} -- env HOME=${KLONKT_DIR} npm run reset-admin"
echo
echo "  DNS: zorg dat A + AAAA van ${KLONKT_DOMAIN} naar deze server wijzen."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
