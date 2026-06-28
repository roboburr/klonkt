/**
 * Admin: Updates (god-only).
 *   GET  /admin/updates      -> current vs. latest version + status
 *   POST /admin/updates/run  -> fetch latest + restart (fleet only; see below)
 *
 * Two topologies are supported, detected automatically:
 *   - CHECKOUT (external self-hoster): the app dir is itself a git clone with
 *     origin = GitHub. "Latest" = origin/<branch> (fetched on view). Updating is
 *     done out-of-band by `klonkt-update` (needs root for systemd), so the page
 *     shows that command instead of an in-app button.
 *   - BARE (Robin's own VPS fleet): a bare repo at KLONKT_GIT_DIR; the app dir is
 *     a `checkout -f` work-tree (no .git). "Latest" = <branch>. The detached
 *     self-update script runs in-app (no root needed) → the button works.
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

router.get('/', requireGod, (req, res) => {
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
