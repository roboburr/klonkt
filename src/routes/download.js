/**
 * Download-voor-email (premium feature #2).
 *
 *   GET  /downloads                 -> lijst van downloadbare tracks (premium; anders 404)
 *   GET  /download/:id              -> e-mail-capture-pagina voor één track
 *   POST /download/:id              -> e-mail opslaan (-> mailinglijst) + download vrijgeven
 *   GET  /download/:id/bestand      -> serveert het bestand (sessie-gated na capture)
 *
 * De fan laat z'n e-mail achter en krijgt het bestand; het adres komt in de
 * subscribers-lijst (source 'download', single opt-in — geen confirm-drempel vóór de
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

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.resolve(process.env.AUDIO_PATH || path.join(__dirname, '..', '..', 'storage', 'audio'));

const MIME = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg' };
const GRACE_MS = 15 * 60 * 1000; // download-venster na capture

function dlTrack(siteId, id) {
  return db.prepare(
    `SELECT t.id, t.title, t.artist, t.cover_url, m.storage_path
       FROM audio_tracks t JOIN media m ON m.id = t.media_id
      WHERE t.id = ? AND t.site_id = ? AND t.downloadable = 1`
  ).get(id, siteId);
}
function safeName(title, storagePath) {
  const ext = path.extname(storagePath || '').toLowerCase() || '.mp3';
  const base = String(title || 'track').replace(/[^a-zA-Z0-9 _.-]/g, '').trim().slice(0, 80) || 'track';
  return base + ext;
}

// Lijst van downloadbare tracks.
router.get('/downloads', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();
  const tracks = db.prepare(
    `SELECT id, title, artist, cover_url FROM audio_tracks
      WHERE site_id = ? AND downloadable = 1 ORDER BY position ASC, created_at ASC`
  ).all(site.id);
  renderPage(req, res, 'pages/downloads', {
    pageTitle: 'Downloads — ' + (site.title || ''),
    bodyClass: 'on-downloads',
    dlTracks: tracks,
  });
});

// Capture-pagina voor één track.
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

// E-mail opslaan + download vrijgeven.
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
  // Download vrijgeven in de sessie (kort venster).
  if (!req.session.dl) req.session.dl = {};
  req.session.dl[track.id] = Date.now();
  renderPage(req, res, 'pages/download', {
    pageTitle: track.title + ' — download', bodyClass: 'on-download',
    dlState: 'ready', dlTrack: track,
  });
});

// Het bestand serveren — alleen als er net een e-mail is achtergelaten (sessie).
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
  const sp = track.storage_path;
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
