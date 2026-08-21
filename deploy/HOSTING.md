# Running Klonkt for other people

A runbook for someone who has a VPS and is about to host Klonkt instances for
people who are not themselves.

This is **not** an install guide. For that:

| | |
|---|---|
| [DEPLOY.md](DEPLOY.md) | one Klonkt, from bare VPS to running |
| [MULTI-INSTANCE.md](MULTI-INSTANCE.md) | the split layout, `klonkt@<slug>` units |

Those tell you how. This one tells you what changes the moment the data on your
disk stops being yours.

---

## 0. The question to answer first

**Are you hosting for yourself, or for other people?**

If it is only you, stop reading and use the two guides above. Everything below is
about the second case, and the difference is not technical. One Klonkt is one
person, so the moment there is a second instance there is a second person, and
you are now holding their conversations, their contacts, and their identity.

Read §5 before you accept your first user, not after.

---

## 1. Day one

Follow [MULTI-INSTANCE.md](MULTI-INSTANCE.md) for the layout, then:

```bash
sudo bash /opt/klonkt/scripts/klonkt-add-instance.sh <slug> <domain>
```

Leave the port out and a free one is chosen. Then check it came up:

```bash
systemctl status klonkt@<slug>
```

Before you tell anyone it is ready, do these three:

1. **Test the backup, do not just install it.** Run `deploy/backup.sh` once by
   hand and then actually unpack the tarball somewhere and look inside. A backup
   you have never restored is a hope, not a backup.
2. **Check the disk.** Media grows quietly; databases do not. `df -h` now, and
   know what number worries you.
3. **Update once on purpose**, while nobody is depending on it, so the first time
   you run `klonkt-update` is not also the first time you find out what it does.

---

## 2. The weekly rhythm

Nothing here takes long. Skipping it is how small problems become 3am problems.

```bash
systemctl list-units 'klonkt@*'                                  # still running?
df -h                                                            # disk
journalctl -u 'klonkt@*' --since '7 days ago' -p warning --no-pager
```

If that last one answers `Failed to add filter for units: No data available`,
nothing matched — which is usually the good news (no warnings in the window), not
a broken command. Widen the window before you go looking for a fault.

`-u` matches against the units that actually appear in the journal, so an
instance that logged nothing at all is simply absent. Run it as root: an
unprivileged account sees only its own messages and will get the same empty
answer for the wrong reason.

The log line worth reading properly is anything about federation: a rejected
signature, a delivery that keeps retrying. Those are usually the other side's
problem, but they are also how you find out that one of your users has been
invisible to half the fediverse for a week.

---

## 3. Updating, and getting back

```bash
klonkt-update
```

One command updates the shared code and restarts **every** instance on the
machine. That is the point of the shared layout, and it is also the risk: a bad
release takes all of your users down at once, not one.

So before you update:

- **know what you are on.** `git -C /opt/klonkt rev-parse --abbrev-ref HEAD`.
  `stable` is what you want unless you have decided otherwise on purpose.
- **do it when you are awake.** Not before you leave the house.

`klonkt-update` prints the previous commit and the command to go back. It looks
like this:

```bash
runuser -u klonkt -- git -C /opt/klonkt checkout -qf -B stable <previous-sha>
systemctl restart 'klonkt@*'
```

The glob only matches units systemd already has loaded. An instance that was
stopped will be skipped, so check with `systemctl list-units 'klonkt@*'
--all` afterwards rather than assuming.

That only works if the checkout has history. Older installs were cloned shallow
and could not roll back at all; the updater now deepens once, on its first run
after this change. If you are not sure:

```bash
git -C /opt/klonkt rev-parse --is-shallow-repository   # want: false
```

`true` means you cannot roll back yet. Run
`sudo bash /opt/klonkt/scripts/klonkt-refresh-updater.sh` and then
`klonkt-update` once.

**Roll back is not atomic.** All instances share one checkout, so during the
switch the code is briefly half-old. For a handful of instances this is seconds
and nobody notices. It is still the reason to keep a maintenance page in mind if
you ever grow.

---

## 4. When it breaks

**An instance will not start.**

```bash
journalctl -u klonkt@<slug> -n 50 --no-pager
```

Nine times out of ten it is the `.env`: a missing `SESSION_SECRET`, or a path
that points at a directory that no longer exists. The app refuses to boot rather
than come up half-configured, which is deliberate.

**One instance is broken, the rest are fine.** Do not run `klonkt-update` hoping
it helps — it restarts everyone to fix one. Restart the single unit.

**Everything is broken after an update.** Roll back (§3) first, ask why second.

**Disk full.** Media, then logs. `journalctl --vacuum-size=200M` buys you room
immediately; the media is a conversation with the user, not a delete decision you
make alone.

---

## 5. What you are actually holding

This is the section people skip. Do not.

Each instance's data directory contains that person's database: their posts,
their private messages, who they follow, and — if they are a ward or a guardian —
their guardianship relationships. It also contains **the private key of their
fediverse actor**.

That last one is not a privacy nuance. Whoever has that key can post as that
person, follow as that person, and send messages as that person, and the rest of
the fediverse has no way to tell. You have it because you have the machine. There
is no configuration that takes it away.

So:

- **Say so.** Tell the people you host, in plain words, that you can technically
  read and impersonate. It is better coming from you than discovered later.
- **Do not build tooling that makes it easy.** Never export or display actor keys
  from an admin panel. It prevents nothing, but a tool that offers it invites it.
- **Guardianship data deserves more care than the rest.** A ward is often a
  minor, and a 🛟 help request is a distress signal. That a guardianship exists
  may be visible to you for support. What is in it is not yours to read.

### If someone changes hoster

An ActivityPub `Move` does **not** apply here. Move takes an actor from one id to
another and tells the followers to re-follow. If the domain stays the same, the
actor id stays the same, and there is nothing to move: the fediverse only ever
sees the URI and cannot tell which machine answers it. Changing hoster with the
same domain is a server migration. Copy the data across and the world notices
nothing.

Which leaves the key, and Move would not have helped with that either — a Move
carries no keys; the new actor simply has its own.

So the choice is: take the key along, or make a new one.

Take it along and everything keeps working — **and the old hoster keeps a working
copy, permanently.** ActivityPub has no revocation. Nothing marks a key as no
longer valid; it is only superseded once other servers refetch the actor.

Klonkt cannot rotate keys today. `getOrCreateKeys()` creates a pair when there is
none and never replaces one. So for now, treat a change of hoster as what it is:
the previous hoster can go on signing as that person, and the only real mitigation
is choosing hosters you would trust after the fact.

Say this out loud to anyone leaving you, and to anyone arriving.

The fediverse is working on the root of this. FEP-521a (final) already lets an
actor publish several keys at once, which is what a graceful rotation would need —
though it deliberately stops at the representation and says nothing about when an
old key stops counting. FEP-ef61, *Portable Objects* (draft), goes further: it
gives objects server-independent ids and allows the signing key to live with the
**user** instead of the server. On that model a change of hoster leaks nothing,
because the hoster never held the key. That is where this should end up; it is not
where it is today.

### The legal shape

Under the GDPR you are a **processor**: you handle personal data on behalf of
someone else, who is the controller. That relationship needs a written agreement
(Art. 28). This is true even if you host for free, and even for one friend.

If you also use the data for your own purposes — statistics across instances,
moderating what people post, backups you keep for your own reasons — you are no
longer only a processor, and the bar is higher.

The single-user design helps you here more than you would expect. A request to
see or delete everything about one person is *one instance*, not a query across
shared tables. You can answer it honestly, and prove it.

---

## 6. Letting someone leave

A hoster who cannot be left is not a hoster. Klonkt has a portable content
archive; see [../docs/EXPORT-FORMAT.md](../docs/EXPORT-FORMAT.md).

```bash
cd /opt/klonkt
node scripts/export-archive.mjs <slug> --out /tmp/<slug>-archive.zip
```

It contains their posts, their media, and the replies underneath as a read-only
record. No credentials, no keys. Hand it over and it can be imported into another
Klonkt.

Two things to know before you hand it over:

- If the site has **paid posts**, the archive contains their full text. Treat the
  file like the content itself.
- The **ActivityPub ids survive** only if the new home has the same domain.
  Moving to a different domain means new ids, and the boosts and replies that
  point at the old ones do not follow. That is a property of the fediverse, not
  of the export.

Then remove the instance ([MULTI-INSTANCE.md](MULTI-INSTANCE.md) §Removing an
instance) — and only after they confirm the archive opens.

---

## 7. Things not to do

- **Do not host for people you would not tell about §5.** If you would rather
  they did not know what you can see, you should not be holding it.
- **Do not update to fix one instance.** It restarts all of them.
- **Do not put security updates behind anything.** If you ever charge for
  hosting, charge for the convenience — scheduled, all at once, with a way back
  — never for the update itself. An unpatched fediverse server is a problem for
  everyone it talks to, not only for you.
- **Do not keep backups you have never restored.** See §1.
- **Do not delete someone's instance the same day they ask.** Export first,
  confirm they can open it, then remove.
