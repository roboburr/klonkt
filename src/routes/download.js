/**
 * Download-for-email (premium feature #2).
 *
 *   GET  /downloads                 -> list of downloadable tracks (premium; 404 otherwise)
 *   GET  /download/:id              -> email capture page for a single track
 *   POST /download/:id              -> save email (-> mailing list) + unlock download
 *   GET  /download/:id/bestand      -> serves the file (session-gated after capture)
 *
 * The fan leaves their email and receives the file; the address is added to the
 * subscribers list (source 'download', single opt-in — no confirm step before the
 * download). Hub: via /user/:slug/... (resolveSite + siteUrlBase).
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { premiumUnlocked } from '../services/PatreonService.js';
import { addSubscriber } from '../services/SubscriberService.js';
import { postNeighbors } from './posts.js';

const router = express.Router();

// If a real (pinned) post with slug 'downloads' exists, the downloads list is
// effectively attached to that post. We then also show the Newer/Older post nav
// so the visitor can browse just like on a regular post.
function downloadsPostNav(req, res) {
  const site = res.locals.site;
  if (!site) return {};
  const post = db.prepare(
    "SELECT id, slug, pinned FROM posts WHERE site_id = ? AND slug = 'downloads' AND status = 'published'"
  ).get(site.id);
  if (!post) return {};
  try { return postNeighbors(site, post, res.locals.tenancy === 'hub'); } catch (e) { return {}; }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.resolve(process.env.AUDIO_PATH || path.join(__dirname, '..', '..', 'storage', 'audio'));

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
const GRACE_MS = 15 * 60 * 1000; // download window after capture

function dlTrack(siteId, id) {
  return db.prepare(
    `SELECT t.id, t.title, t.artist, t.cover_url, m.storage_path, m.filename
       FROM audio_tracks t JOIN media m ON m.id = t.media_id
      WHERE t.id = ? AND t.site_id = ? AND t.downloadable = 1`
  ).get(id, siteId);
}
function safeName(title, storagePath) {
  const ext = path.extname(storagePath || '').toLowerCase() || '.mp3';
  const base = String(title || 'track').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 80) || 'track';
  return base + ext;
}

// List of downloadable tracks.
router.get('/downloads', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const tracks = db.prepare(
    `SELECT id, title, artist, cover_url FROM audio_tracks
      WHERE site_id = ? AND downloadable = 1 ORDER BY position ASC, created_at ASC`
  ).all(site.id);
  const nav = downloadsPostNav(req, res);
  renderPage(req, res, 'pages/downloads', {
    pageTitle: 'Downloads — ' + (site.title || ''),
    // on-special = compact profile header (like on a post); on-downloads = grey pill
    // + feature-route behaviour. Together → downloads looks just like a post.
    bodyClass: 'on-downloads on-special',
    dlTracks: tracks,
    newerPost: nav.newerPost || null,
    olderPost: nav.olderPost || null,
  });
});

// Capture page for a single track.
router.get('/download/:id', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const track = dlTrack(site.id, req.params.id);
  if (!track) return next();
  const fan = req.session && req.session.user;
  renderPage(req, res, 'pages/download', {
    pageTitle: track.title + ' — download',
    bodyClass: 'on-download',
    dlState: 'form',
    dlTrack: track,
    dlPrefill: (fan && fan.email && fan.email.includes('@')) ? fan.email : '',
  });
});

// Save email + unlock download.
router.post('/download/:id', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const track = dlTrack(site.id, req.params.id);
  if (!track) return next();
  const email = (req.body.email || '').trim();
  const r = addSubscriber(site.id, email, 'download', { doubleOptin: false });
  if (!r.ok) {
    return renderPage(req, res, 'pages/download', {
      pageTitle: track.title + ' — download', bodyClass: 'on-download',
      dlState: 'form', dlTrack: track, dlPrefill: email,
      dlError: r.error === 'invalid_email' ? 'Controleer je e-mailadres.' : 'Er ging iets mis.',
    });
  }
  // Unlock download in the session (short window).
  if (!req.session.dl) req.session.dl = {};
  req.session.dl[track.id] = Date.now();
  renderPage(req, res, 'pages/download', {
    pageTitle: track.title + ' — download', bodyClass: 'on-download',
    dlState: 'ready', dlTrack: track,
  });
});

// Serve the file — only if an email was just submitted (session-gated).
router.get('/download/:id/bestand', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const track = dlTrack(site.id, req.params.id);
  if (!track) return next();
  const ts = req.session && req.session.dl && req.session.dl[track.id];
  if (!ts || (Date.now() - ts) > GRACE_MS) {
    return res.status(403).send('Laat eerst je e-mailadres achter om te downloaden.');
  }
  // The playable/downloadable file = the BARE filename (storage_path is an
  // absolute path → fails the slash-guard). Same approach as /audio/stream.
  const sp = track.filename;
  if (!sp || sp.includes('/') || sp.includes('\\') || sp.includes('..')) return res.status(400).send('Bad path');
  const filePath = path.join(AUDIO_DIR, sp);
  if (!filePath.startsWith(AUDIO_DIR + path.sep)) return res.status(400).send('Bad path');
  let stat;
  try { stat = fs.statSync(filePath); } catch { return res.status(404).send('Bestand niet gevonden'); }
  if (!stat.isFile()) return res.status(404).send('Bestand niet gevonden');
  const ext = path.extname(sp).toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', 'attachment; filename="' + safeName(track.title, sp) + '"');
  fs.createReadStream(filePath).pipe(res);
});

export default router;
