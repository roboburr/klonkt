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

# On a split install the old single unit must not be startable at all.
# `disable` is not enough (restart starts a disabled unit anyway) and `mask`
# refuses while the real file sits in /etc/systemd/system, the highest-priority
# directory. Moving the file aside is what actually works: systemd stops
# knowing the unit, so any restart fails loudly instead of quietly starting a
# second process that writes an empty database into the checkout.
SPLIT=0
for d in "${DATA_ROOT}"/*/; do [ -f "$d/.env" ] && SPLIT=1 && break; done
if [ "$SPLIT" = 1 ] && [ -f /etc/systemd/system/klonkt.service ]; then
  systemctl stop klonkt.service 2>/dev/null || true
  systemctl disable klonkt.service 2>/dev/null || true
  RETIRED="/etc/systemd/system/klonkt.service.retired-$(date +%Y%m%d%H%M%S)"
  if mv /etc/systemd/system/klonkt.service "$RETIRED"; then
    systemctl daemon-reload
    echo "retired klonkt.service → $RETIRED (move it back + daemon-reload to roll back)"
  else
    echo "WARNING: could not move /etc/systemd/system/klonkt.service aside."
    echo "         Until you do, any 'systemctl restart klonkt' starts a second"
    echo "         process that writes an empty database into ${KLONKT_DIR}."
  fi
fi

# A leftover storage/ in the checkout means something ran without the instance
# config. Report it; never delete it unattended — only its owner can tell
# whether it holds anything.
if [ "$SPLIT" = 1 ] && [ -e "${KLONKT_DIR}/storage" ]; then
  echo
  echo "WARNING: ${KLONKT_DIR}/storage exists while instance data lives in ${DATA_ROOT}."
  echo "         Something ran without the instance .env and wrote here. Check with:"
  echo "             sqlite3 ${KLONKT_DIR}/storage/database.sqlite 'select count(*) from posts;'"
  echo "         If it is empty, it is a stray from a resurrected klonkt.service and"
  echo "         can be removed. If it is NOT empty, do not delete it: ask first."
fi
