# Running several Klonkts on one server

One copy of the code, one directory of data per site. Adding a site is a
directory and an `.env` file; updating is one command for all of them.

```
/opt/klonkt/                  the code. Shared. Replaceable. No user data.
/var/lib/klonkt/<slug>/       one instance: its .env, database, uploads.
    .env
    database.sqlite
    media/
    audio/
```

A *slug* is just a short name for an instance: `boiert`, `blog`, `label`. It is
the directory name under `/var/lib/klonkt` and the systemd instance name
(`klonkt@boiert`). It never appears in a URL.

New installs get this layout on their own; the installer derives the slug from
the domain (`boiert.eu` becomes `boiert`) unless you set `KLONKT_SLUG`. Servers
installed before this existed keep their old layout untouched until you convert
them, which is the section below.

## Why the split

When the database and uploads sit inside the checkout, the code directory holds
live user data. That has three consequences you feel sooner or later:

- **Updates get risky.** Anything that cleans up the checkout can reach your
  uploads. Deleting and re-cloning the code becomes impossible.
- **Backups get vague.** You either back up the code as well or you have to pick
  the data out from between it.
- **A second site needs a second copy of everything**, including `node_modules`,
  and every copy has to be updated separately.

After the split the checkout is disposable: throw it away, clone it again, and
every instance still has its data. Backing up `/var/lib/klonkt/<slug>` backs up
the whole instance, configuration included.

## Who owns what

Everything runs as the unprivileged `klonkt` system user, which is created by
the installer and cannot log in.

| Path | Owner | Mode | Written by |
|---|---|---|---|
| `/opt/klonkt` | `klonkt` | `0755` | `klonkt-update`, never the running app |
| `/var/lib/klonkt/<slug>` | `klonkt` | `0750` | the app |
| `/var/lib/klonkt/<slug>/.env` | `klonkt` | `0600` | you |

Root is needed to install the systemd unit, create the directory and edit the
web server config. The application itself never runs as root.

The service unit narrows this further:

```ini
ProtectSystem=strict
ReadWritePaths=/var/lib/klonkt/%i
```

The whole filesystem is read-only to the process except its own data directory.
An instance cannot write into the code, and it cannot reach another instance's
data, even if something inside the application goes wrong.

## Migrating an existing install

For a server that was installed the single site way, with everything under
`/opt/klonkt`. Update the code first: the split needs a build where every media
subdirectory follows `MEDIA_PATH`, and the script refuses to run on anything
older.

```bash
klonkt-update
sudo bash /opt/klonkt/scripts/klonkt-migrate-data.sh <slug> --dry-run
sudo bash /opt/klonkt/scripts/klonkt-migrate-data.sh <slug>
```

Pick a slug that describes the site, for example `boiert` for boiert.eu. The
script stops the service (so SQLite writes out its log), moves `storage/` and
`.env` to `/var/lib/klonkt/<slug>/`, rewrites the three data paths, installs the
systemd template, and switches from `klonkt.service` to `klonkt@<slug>`.

Your web server config does not change. The instance keeps the same port,
because the port comes from the same `.env`.

**Rolling back.** The old `klonkt.service` is disabled but not deleted. To go
back, move the data into `/opt/klonkt/storage`, restore the relative paths in
`.env`, and run `systemctl enable --now klonkt`.

## Adding an instance

```bash
sudo bash /opt/klonkt/scripts/klonkt-add-instance.sh blog blog.example.com
```

That creates `/var/lib/klonkt/blog`, writes an `.env` with a fresh random
`SESSION_SECRET` and a free port, starts `klonkt@blog`, and adds a Caddy block
for the domain. Pass a port as a third argument to choose it yourself, or
`--no-caddy` if you run your own proxy.

Point the DNS at the server first, otherwise the certificate cannot be issued.

Doing it by hand comes down to the same four things:

```bash
sudo mkdir -p /var/lib/klonkt/blog
sudo tee /var/lib/klonkt/blog/.env >/dev/null <<'ENV'
NODE_ENV=production
PORT=3001
HOST=127.0.0.1
SESSION_SECRET=<openssl rand -hex 32>
PUBLIC_BASE_URL=https://blog.example.com
DATABASE_PATH=/var/lib/klonkt/blog/database.sqlite
MEDIA_PATH=/var/lib/klonkt/blog/media
AUDIO_PATH=/var/lib/klonkt/blog/audio
ENV
sudo chown -R klonkt:klonkt /var/lib/klonkt/blog
sudo chmod 750 /var/lib/klonkt/blog && sudo chmod 600 /var/lib/klonkt/blog/.env
sudo systemctl enable --now klonkt@blog
```

Every instance needs its own `PORT` and its own `PUBLIC_BASE_URL`. Give each one
its own `SESSION_SECRET` as well: sharing it would make sessions from one site
valid on another.

The three data paths are the only ones you need. Media subdirectories such as
`media/avatars` and `media/post-images` follow `MEDIA_PATH` on their own.

## Updating them all at once

```bash
sudo klonkt-update
```

That pulls the code once into `/opt/klonkt`, reinstalls dependencies only when
`package-lock.json` changed, and restarts every instance it finds under
`/var/lib/klonkt`. There is one copy of the code, so no instance can lag behind.

Watch one instance while it comes back:

```bash
journalctl -u klonkt@blog -f
```

## Backups

One directory per instance:

```bash
systemctl stop klonkt@blog
tar czf blog-$(date +%F).tar.gz -C /var/lib/klonkt blog
systemctl start klonkt@blog
```

Stopping first keeps the SQLite file consistent. To back up without downtime,
use `sqlite3 database.sqlite ".backup snapshot.db"` and archive the snapshot
together with `media/` and `audio/`.

There is nothing to back up in `/opt/klonkt`: it is a checkout of a public
repository and `klonkt-update` recreates it.

## Removing an instance

```bash
sudo systemctl disable --now klonkt@blog
sudo rm -rf /var/lib/klonkt/blog      # this deletes the site's data
```

Then remove its block from the web server config and reload it.

## Everyday commands

| | |
|---|---|
| `systemctl status klonkt@<slug>` | is it running |
| `journalctl -u klonkt@<slug> -f` | follow the log |
| `systemctl restart klonkt@<slug>` | restart one instance |
| `klonkt-update` | update the code, restart all instances |
| `ls /var/lib/klonkt` | which instances exist |
