# PrutCMS v10 — Deployment Guide

End-to-end production install on a fresh Ubuntu 22.04 / Debian 12 VPS
(TransIP, Hetzner, etc.). Assumes a non-root user with sudo.

---

## 0. Prerequisites

- VPS with Ubuntu 22.04 LTS or Debian 12.
- DNS A/AAAA records for your domain pointing at the server's IP. Wait for
  propagation (`dig +short YOUR-DOMAIN` should return the right IP) before
  running certbot.
- SSH access as a non-root user (e.g. `robin`).

---

## 1. System packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl ca-certificates git nginx ufw sqlite3
```

Install Node.js 20 LTS via NodeSource (don't use the OS-default — it's old):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # should print v20.x.x
```

Install PM2 globally:

```bash
sudo npm install -g pm2
```

---

## 2. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'   # opens 80 + 443
sudo ufw enable
```

---

## 3. App user + project clone

```bash
# As root or via sudo, create a deploy user if you don't already have one
# (skip if you're already on a non-root user)

# As your user:
mkdir -p ~/prutcms
cd ~/prutcms
# Clone or rsync your code here. e.g. via git:
# git clone <your-repo> .

npm ci --omit=dev
```

`ensureLocalHtmx()` in `server.js` will copy the bundled HTMX from
`node_modules/htmx.org/dist/htmx.min.js` to `src/assets/js/htmx.min.js` on
first boot. You don't have to do that step manually.

---

## 4. Environment variables

Create `.env` in the project root:

```ini
NODE_ENV=production
PORT=3000

# 32+ random hex chars — required, the app refuses to boot without it.
# Generate: openssl rand -hex 32
SESSION_SECRET=<paste-strong-random-string>

# Optional: pin the audio HMAC secret instead of letting the app generate one
# in storage/.audio-secret. Generate the same way as SESSION_SECRET.
# AUDIO_SECRET=<paste-different-random-string>

# Optional: override storage paths
# DATABASE_PATH=/home/robin/prutcms/storage/database.sqlite
# AUDIO_PATH=/home/robin/prutcms/storage/audio
# AVATAR_PATH=/home/robin/prutcms/storage/media/avatars
# COVER_PATH=/home/robin/prutcms/storage/media/audio-covers
# MEDIA_PATH=/home/robin/prutcms/storage/media
```

`chmod 600 .env` — keep it readable only by your user.

---

## 5. First boot

```bash
npm run migrate    # creates storage/database.sqlite + tables
```

Then start with PM2:

```bash
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup        # follow the printed command to make PM2 survive reboots
```

Check it's up:

```bash
curl -I http://127.0.0.1:3000/   # expect 200 / 302
pm2 logs prutcms                 # live logs; Ctrl-C to detach
```

Register your first user (becomes god) by visiting
`http://YOUR-SERVER-IP:3000/auth/register` BEFORE you point nginx at it
(or just wait until SSL is up — registration works the same).

---

## 6. nginx + SSL

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/prutcms
sudo $EDITOR /etc/nginx/sites-available/prutcms     # replace <YOUR-DOMAIN>
sudo ln -s /etc/nginx/sites-available/prutcms /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Install certbot and provision certs:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo mkdir -p /var/www/letsencrypt
sudo certbot --nginx -d YOUR-DOMAIN -d www.YOUR-DOMAIN
```

Certbot edits the nginx config in place to wire in the certificate paths.
Renewals run automatically via the certbot systemd timer; verify with:

```bash
sudo systemctl status certbot.timer
```

Now visit `https://YOUR-DOMAIN/`. You should see your site over HTTPS, with
HSTS active and Prutter WebSocket working (browser dev-tools → Network →
filter "WS" → see the `wss://YOUR-DOMAIN/ws/prutter` connection).

---

## 7. Backups

```bash
chmod +x deploy/backup.sh
mkdir -p ~/backups/prutcms ~/prutcms/logs

# Test it once
./deploy/backup.sh

# Schedule nightly at 03:00
( crontab -l 2>/dev/null ; \
  echo "0 3 * * * /home/$USER/prutcms/deploy/backup.sh >> /home/$USER/prutcms/logs/backup.log 2>&1" \
) | crontab -

crontab -l   # verify
```

Restore is a tar -xzf into a clean directory + `npm ci` + start.

---

## 8. Updating

```bash
cd ~/prutcms
git pull
npm ci --omit=dev
pm2 reload prutcms     # zero-downtime within fork mode
```

The DB schema migrates automatically on boot (`ensureColumn` adds new columns
idempotently). For destructive changes you'd need to write an explicit
migration — not yet needed.

---

## 9. Multi-tenant setup

After your first user/site is created (auto on first registration), use
`/admin/sites` to create more sites. Each site gets its own URL prefix
(`/sites/<slug>/`) and its own PWA scope, so installing the PWA from one
site won't navigate into another.

---

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| `❌ FATAL: SESSION_SECRET is required` | `.env` missing or unreadable. `pm2 stop prutcms && pm2 start ecosystem.config.cjs --env production`. |
| `❌ FATAL: SESSION_SECRET too weak for production` | Make it 32+ chars: `openssl rand -hex 32`. |
| WS disconnects every minute | Check nginx `proxy_read_timeout` is ≥ 90s in `/ws/` block. |
| Audio plays but seek stutters | nginx must have `proxy_buffering off` on `/audio/stream/`. |
| 502 from nginx | `pm2 list` — is the app up? `pm2 logs prutcms --lines 100`. |
| HTMX 404s on `/assets/js/htmx.min.js` | `ls node_modules/htmx.org/dist/htmx.min.js` — if missing, `npm install htmx.org`. The boot-copy step needs the package. |

---

## 11. What's NOT included

- Email sending (password reset prints the URL to the console / page in
  non-production). Hook up an SMTP or transactional service when needed.
- Cluster mode / horizontal scaling. Single fork only — see comments in
  `ecosystem.config.cjs` for what would have to change first.
- Off-site backup replication. The local rotation keeps 14 days; copy the
  tar.gz files off-server with rsync/restic/whatever you prefer.
