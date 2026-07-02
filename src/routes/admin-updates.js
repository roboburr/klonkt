/**
 * Admin: Updates (god-only).
 *   GET  /admin/updates      -> current vs. latest version + status
 *   POST /admin/updates/run  -> fetch latest + restart (fleet only; see below)
 *
 * Three topologies are supported, detected automatically:
 *   - CHECKOUT (external self-hoster): the app dir is itself a git clone with
 *     origin = GitHub. "Latest" = origin/<branch> (fetched on view). Updating is
 *     done out-of-band by `klonkt-update` (needs root for systemd), so the page
 *     shows that command instead of an in-app button.
 *   - BARE (Robin's own VPS fleet): a bare repo at KLONKT_GIT_DIR; the app dir is
 *     a `checkout -f` work-tree (no .git). "Latest" = <branch>. The detached
 *     self-update script runs in-app (no root needed) → the button works.
 *   - ANDROID (the Klonkt phone app, Termux — node reports platform 'android'):
 *     installed from a prebuilt tarball, no git at all. "Latest" = the package
 *     version on the klonkt STABLE branch (the channel the phone tarballs are
 *     built from). The button runs the phone's own `klonkt-update` command
 *     detached, which survives the server restart it causes.
 * git stderr is ignored so a foreign/missing repo never spams "fatal: ...".
 */

import express from 'express';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';

const router = express.Router();

const HOME = process.env.HOME || '';
const APP_DIR = process.cwd();
const BRANCH = process.env.KLONKT_BRANCH || 'main';
const GIT_DIR = process.env.KLONKT_GIT_DIR || path.join(HOME, 'git-repos/prutfolio.git');
const UPDATE_SCRIPT = process.env.KLONKT_UPDATE_SCRIPT || path.join(HOME, 'bin/klonkt-self-update.sh');

// The app dir is a git CHECKOUT (GitHub install) when it has a .git; otherwise we
// fall back to the BARE repo (fleet). This split keeps the version check pointed at
// a repo that actually exists, so it never logs "fatal: not a git repository".
const IS_CHECKOUT = (() => { try { return fs.existsSync(path.join(APP_DIR, '.git')); } catch { return false; } })();
const REMOTE_REF = IS_CHECKOUT ? `origin/${BRANCH}` : BRANCH; // what "latest" resolves to

// The Klonkt Android app (Termux): node there reports platform 'android'; the
// filesystem check is belt-and-braces for exotic node builds.
const IS_ANDROID = process.platform === 'android'
  || (() => { try { return fs.existsSync('/data/data/com.termux/files/usr/bin'); } catch { return false; } })();
// Phone tarballs are built from the stable branch → that's the phone's "latest".
const ANDROID_LATEST_URL = 'https://raw.githubusercontent.com/roboburr/klonkt/stable/package.json';

async function androidLatestVersion() {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(ANDROID_LATEST_URL, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()).version || null;
  } catch { return null; }
}

function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}
// stderr is ignored on purpose → a missing/foreign repo fails silently (returns null).
function git(args) {
  try {
    const base = IS_CHECKOUT ? ['-C', APP_DIR] : ['--git-dir', GIT_DIR];
    return execFileSync('git', [...base, ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}
function currentSha() {
  if (IS_CHECKOUT) return git(['rev-parse', 'HEAD']);
  try { return fs.readFileSync(path.join(APP_DIR, '.klonkt-version'), 'utf8').trim() || null; } catch { return null; }
}

// Last 5 commits = the "recent changes" you'll get when updating.
function recentChanges() {
  const out = git(['log', '-5', '--format=%s%x1f%cd', '--date=short', REMOTE_REF]);
  if (!out) return [];
  return out.split('\n').map((l) => {
    const i = l.indexOf('\x1f');
    return i >= 0 ? { msg: l.slice(0, i), date: l.slice(i + 1) } : { msg: l, date: '' };
  });
}

router.get('/', requireGod, async (req, res) => {
  // ANDROID: version-based check against the stable branch; the update button
  // runs the phone's klonkt-update (always present, the start script writes it).
  if (IS_ANDROID) {
    const cur = appVersion();
    const latest = await androidLatestVersion();
    return renderPage(req, res, 'pages/admin-updates', {
      pageTitleKey: 'admin.t_updates',
      bodyClass: 'on-admin',
      appVersion: cur,
      currentSha: cur ? 'v' + cur : null,
      currentDesc: null,
      latestSha: latest ? 'v' + latest : null,
      latestDesc: null,
      upToDate: !!(cur && latest && cur === latest),
      canCheck: !!latest,
      canSelfUpdate: true,
      manualCommand: null,
      behind: null,
      changes: [],
      success: req.query.success || null,
      error: req.query.error || null,
    });
  }
  // For a GitHub checkout, refresh the remote ref so "latest" is current. Quiet +
  // shallow; offline just leaves the last-known ref. stderr ignored (no log noise).
  if (IS_CHECKOUT) {
    try { execFileSync('git', ['-C', APP_DIR, 'fetch', '--quiet', '--depth', '1', 'origin', BRANCH], { timeout: 20000, stdio: 'ignore' }); } catch { /* offline / no remote */ }
  }
  const cur = currentSha();
  const latest = git(['rev-parse', REMOTE_REF]);
  // The in-app "Update now" button only works with the detached self-update script
  // (the fleet). A systemd install updates via `klonkt-update` (root) → show that.
  const canSelfUpdate = (() => { try { return fs.existsSync(UPDATE_SCRIPT); } catch { return false; } })();
  renderPage(req, res, 'pages/admin-updates', {
    pageTitleKey: 'admin.t_updates',
    bodyClass: 'on-admin',
    appVersion: appVersion(),
    currentSha: cur ? cur.slice(0, 8) : null,
    currentDesc: cur ? git(['log', '-1', '--format=%s · %cd', '--date=short', cur]) : null,
    latestSha: latest ? latest.slice(0, 8) : null,
    latestDesc: latest ? git(['log', '-1', '--format=%s · %cd', '--date=short', REMOTE_REF]) : null,
    upToDate: !!(cur && latest && cur === latest),
    canCheck: !!latest,
    canSelfUpdate,
    manualCommand: (!canSelfUpdate && IS_CHECKOUT) ? 'sudo klonkt-update' : null,
    behind: (cur && latest && cur !== latest) ? git(['rev-list', '--count', cur + '..' + REMOTE_REF]) : null,
    changes: recentChanges(),
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

router.post('/run', requireGod, (req, res) => {
  // ANDROID: run the phone's updater detached. It kills node (this process),
  // swaps the code while keeping storage/.env, and restarts everything — the
  // detached shell survives the pkill because it isn't a node process.
  if (IS_ANDROID) {
    try {
      const child = spawn('bash', ['-c', 'klonkt-update >> "$HOME/klonkt-update.log" 2>&1'], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      return res.redirect('/admin/updates?error=' + encodeURIComponent('Kon update niet starten: ' + (e.message || e)));
    }
    return res.redirect('/admin/updates?success=' + encodeURIComponent('Bijwerken gestart — de site is ~1 minuut bezig (downloaden + herstarten). Ververs daarna deze pagina.'));
  }
  if (!fs.existsSync(UPDATE_SCRIPT)) {
    return res.redirect('/admin/updates?error=' + encodeURIComponent('In-app updaten is hier niet beschikbaar — werk bij met `klonkt-update` op de server.'));
  }
  try {
    // Detached + unlinked: survives the reload that restarts this app.
    const child = spawn('bash', [UPDATE_SCRIPT, APP_DIR], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    return res.redirect('/admin/updates?error=' + encodeURIComponent('Kon update niet starten: ' + (e.message || e)));
  }
  res.redirect('/admin/updates?success=' + encodeURIComponent('Bijwerken gestart — de site herstart over ~10 seconden. Ververs daarna deze pagina.'));
});

export default router;
