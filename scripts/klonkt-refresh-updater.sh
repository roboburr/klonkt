#!/usr/bin/env bash
#
# (Re)write /usr/local/bin/klonkt-update so it matches how this server runs.
#
# Why this exists: the updater is generated once at install time. A server
# that later migrated to the split layout (klonkt@<slug> units) kept its old
# updater, which still restarts the retired klonkt.service. Result: the code
# on disk updates, the restart quietly fails, and the old process keeps
# serving — half old routes, half new templates, which is how you get a 500
# on one page and nothing in the logs that says why.
#
# Idempotent; safe to run any time:
#
#     sudo bash /opt/klonkt/scripts/klonkt-refresh-updater.sh
#
set -euo pipefail

KLONKT_DIR="${KLONKT_DIR:-/opt/klonkt}"
KLONKT_USER="${KLONKT_USER:-klonkt}"
DATA_ROOT="${KLONKT_DATA_ROOT:-/var/lib/klonkt}"
# Follow whatever branch the checkout is on (stable for most self-hosters).
BRANCH="${KLONKT_BRANCH:-$(git -C "$KLONKT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo stable)}"

[ "$(id -u)" = 0 ] || { echo "run this as root (sudo)." >&2; exit 1; }
[ -d "$KLONKT_DIR/.git" ] || { echo "no git checkout at $KLONKT_DIR" >&2; exit 1; }

cat > /usr/local/bin/klonkt-update <<EOF
#!/usr/bin/env bash
set -euo pipefail
D="${KLONKT_DIR}"
B=\$(runuser -u ${KLONKT_USER} -- git -C "\$D" rev-parse HEAD 2>/dev/null || true)
runuser -u ${KLONKT_USER} -- git -C "\$D" fetch --depth 1 origin ${BRANCH}
runuser -u ${KLONKT_USER} -- git -C "\$D" checkout -qf -B ${BRANCH} FETCH_HEAD
A=\$(runuser -u ${KLONKT_USER} -- git -C "\$D" rev-parse HEAD)
if [ "\$B" = "\$A" ]; then
  echo "Klonkt is already up to date (\$A) — nothing to do."
  exit 0
fi
if ! runuser -u ${KLONKT_USER} -- git -C "\$D" diff --quiet "\$B" "\$A" -- package-lock.json 2>/dev/null; then
  runuser -u ${KLONKT_USER} -- env HOME="\$D" bash -c "cd '\$D' && npm ci --omit=dev"
fi
# Restart every instance sharing this checkout: one directory with an .env
# under the data root per instance. No instances there = the pre-split
# single-service layout, which still runs plain klonkt.service.
N=0
for d in ${DATA_ROOT}/*/; do
  [ -f "\$d/.env" ] || continue
  s=\$(basename "\$d")
  systemctl restart "klonkt@\$s" && N=\$((N+1))
done
if [ "\$N" = 0 ]; then
  systemctl restart klonkt
  echo "Klonkt updated (\$A) + restarted."
else
  echo "Klonkt updated (\$A) + restarted \$N instance(s)."
fi
EOF
chmod +x /usr/local/bin/klonkt-update
echo "klonkt-update rewritten: branch ${BRANCH}, code ${KLONKT_DIR}, instances under ${DATA_ROOT}"
