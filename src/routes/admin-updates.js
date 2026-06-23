/**
 * Admin: Updates (god-only).
 * Git-based v1 for instances running from a bare repo.
 *   GET  /admin/updates      -> current vs. latest version + status
 *   POST /admin/updates/run  -> fetch latest main + restart (detached script)
 *
 * The instance knows its "current" commit from .klonkt-version (written by the
 * script) and the "latest" from the bare repo (KLONKT_GIT_DIR). For external
 * self-hosters a SIGNED release feed will follow later (see monetization plan);
 * this v1 is intentionally simple and only for Robin's own VPS instances.
 */

import express from 'express';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';

const router = express.Router();

const HOME = process.env.HOME || '';
const GIT_DIR = process.env.KLONKT_GIT_DIR || path.join(HOME, 'git-repos/prutfolio.git');
const UPDATE_SCRIPT = process.env.KLONKT_UPDATE_SCRIPT || path.join(HOME, 'bin/klonkt-self-update.sh');

function versionFile() { return path.join(process.cwd(), '.klonkt-version'); }
function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}
function git(args) {
  try { return execFileSync('git', ['--git-dir', GIT_DIR, ...args], { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch { return null; }
}
function currentSha() {
  try { return fs.readFileSync(versionFile(), 'utf8').trim() || null; } catch { return null; }
}

// Last 5 commits on main = the "recent changes" you'll get when updating.
function recentChanges() {
  const out = git(['log', '-5', '--format=%s%x1f%cd', '--date=short', 'main']);
  if (!out) return [];
  return out.split('\n').map((l) => {
    const i = l.indexOf('\x1f');
    return i >= 0 ? { msg: l.slice(0, i), date: l.slice(i + 1) } : { msg: l, date: '' };
  });
}

router.get('/', requireGod, (req, res) => {
  const cur = currentSha();
  const latest = git(['rev-parse', 'main']);
  renderPage(req, res, 'pages/admin-updates', {
    pageTitle: 'Updates',
    bodyClass: 'on-admin',
    appVersion: appVersion(),
    currentSha: cur ? cur.slice(0, 8) : null,
    currentDesc: cur ? git(['log', '-1', '--format=%s · %cd', '--date=short', cur]) : null,
    latestSha: latest ? latest.slice(0, 8) : null,
    latestDesc: latest ? git(['log', '-1', '--format=%s · %cd', '--date=short', 'main']) : null,
    upToDate: !!(cur && latest && cur === latest),
    canCheck: !!latest,
    behind: (cur && latest && cur !== latest) ? git(['rev-list', '--count', cur + '..main']) : null,
    changes: recentChanges(),
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

router.post('/run', requireGod, (req, res) => {
  if (!fs.existsSync(UPDATE_SCRIPT)) {
    return res.redirect('/admin/updates?error=' + encodeURIComponent('Update-script ontbreekt op de server.'));
  }
  try {
    // Detached + unlinked: survives the pm2-reload that restarts this app.
    const child = spawn('bash', [UPDATE_SCRIPT, process.cwd()], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    return res.redirect('/admin/updates?error=' + encodeURIComponent('Kon update niet starten: ' + (e.message || e)));
  }
  res.redirect('/admin/updates?success=' + encodeURIComponent('Bijwerken gestart — de site herstart over ~10 seconden. Ververs daarna deze pagina.'));
});

export default router;
