/**
 * admin-media.js — Beheer → Media (image library + cleanup).
 *
 * Lists the uploaded images under storage/media/post-images, shows where each is used, and lets the
 * owner copy a URL or delete unused files. An animated cover's WebP, its loop MP4 (<base>-v.mp4) and
 * poster (<base>-v.jpg) are treated as one item; deleting removes the trio. The Audio half of "Media"
 * stays at /admin/audio (linked as a tab) — this page is the new image side.
 */
import express from 'express';
import path from 'path';
import fs from 'fs';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { audioEnabled } from '../config/features.js';
import { mediaDir } from '../config/paths.js';

const POST_IMAGES_DIR = mediaDir('POST_IMAGES_PATH', 'post-images');

const router = express.Router();

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const VIDEO_EXT = /\.(mp4|webm|m4v|mov)$/i;
// C2S uploads (Shaer's composer and the help buoy) land here; the videos among
// them are what the Video tab shows.
const REPLY_MEDIA_DIR = mediaDir('REPLY_MEDIA_PATH', 'reply-media');
const isSibling = (f) => /-v\.(mp4|jpg)$/i.test(f); // an animated cover's video/poster sibling

// Basename of a /media/post-images/<file> URL (or null).
function baseOf(url) {
  const m = String(url || '').match(/\/media\/post-images\/([^/?#"'\s)]+)/);
  return m ? m[1] : null;
}

// Map filename -> Set(postId) of posts that reference it (as cover or inline image).
function usageMap(siteId) {
  const posts = db.prepare('SELECT id, content, cover_image_url, cover_video_url FROM posts WHERE site_id = ?').all(siteId);
  const map = new Map();
  const add = (fn, id) => { if (!fn) return; if (!map.has(fn)) map.set(fn, new Set()); map.get(fn).add(id); };
  for (const p of posts) {
    add(baseOf(p.cover_image_url), p.id);
    add(baseOf(p.cover_video_url), p.id);
    for (const m of String(p.content || '').matchAll(/\/media\/post-images\/([^/?#"'\s)]+)/g)) add(m[1], p.id);
  }
  return map;
}

function statSize(name) { try { return fs.statSync(path.join(POST_IMAGES_DIR, name)).size; } catch { return 0; } }
function statMtime(name) { try { return fs.statSync(path.join(POST_IMAGES_DIR, name)).mtimeMs; } catch { return 0; } }

// All non-sibling images, each with its loop-MP4 sibling + how many posts use it. Shared by the
// list view and the cleanup route so the readdir/filter/usage logic lives in one place.
function imageEntries(siteId) {
  const used = usageMap(siteId);
  let all = [];
  try { all = fs.readdirSync(POST_IMAGES_DIR).filter(f => !f.startsWith('.')); } catch { /* dir may not exist yet */ }
  const present = new Set(all);
  return all
    .filter(f => IMG_EXT.test(f) && !isSibling(f))
    .map(f => {
      const stem = f.replace(/\.[^.]+$/, '');
      const mp4 = `${stem}-v.mp4`;
      const hasVideo = present.has(mp4);
      const ids = new Set([...(used.get(f) || []), ...(hasVideo ? (used.get(mp4) || []) : [])]);
      return { file: f, stem, mp4, hasVideo, usedCount: ids.size };
    });
}

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  const items = imageEntries(site.id)
    .map(e => ({
      file: e.file,
      url: `/media/post-images/${e.file}`,
      kb: Math.round((statSize(e.file) + (e.hasVideo ? statSize(e.mp4) : 0)) / 1024),
      hasVideo: e.hasVideo,
      usedCount: e.usedCount,
      _mtime: statMtime(e.file),
    }))
    .sort((a, b) => b._mtime - a._mtime); // newest first
  renderPage(req, res, 'pages/admin-media', {
    pageJs: 'admin-media',
    pageTitleKey: 'admin.t_media',
    bodyClass: 'on-admin',
    items,
    unusedCount: items.filter(i => !i.usedCount).length,
    audioOn: audioEnabled(),
    success: req.query.success || null,
  });
});

// Delete one image + its loop-MP4 / poster siblings. Basename-only + within-dir → no traversal.
// ── The Video tab (Robins opdracht, 30-7) ─────────────────────────────────
// Videos live in reply-media (C2S uploads: Shaer's composer, the help buoy).
// Usage is a content/attachment reference from a post, exactly like images.

function videoEntries(siteId) {
  const posts = db.prepare('SELECT id, content, c2s_attachments FROM posts WHERE site_id = ?').all(siteId);
  const used = new Map();
  const add = (fn, id) => { if (!fn) return; if (!used.has(fn)) used.set(fn, new Set()); used.get(fn).add(id); };
  for (const p of posts) {
    for (const m of String(p.content || '').matchAll(/\/media\/reply-media\/([^/?#"'\s)]+)/g)) add(m[1], p.id);
    try { for (const a of JSON.parse(p.c2s_attachments || '[]')) { const m = String(a.url || '').match(/\/media\/reply-media\/([^/?#"'\s)]+)/); if (m) add(m[1], p.id); } } catch { /* malformed never blocks the list */ }
  }
  let all = [];
  try { all = fs.readdirSync(REPLY_MEDIA_DIR).filter(f => !f.startsWith('.')); } catch { /* dir may not exist yet */ }
  const vstat = (name, key) => { try { const st = fs.statSync(path.join(REPLY_MEDIA_DIR, name)); return key === 'size' ? st.size : st.mtimeMs; } catch { return 0; } };
  return all
    .filter(f => VIDEO_EXT.test(f))
    .map(f => ({
      file: f,
      url: `/media/reply-media/${f}`,
      kb: Math.round(vstat(f, 'size') / 1024),
      usedCount: (used.get(f) || new Set()).size,
      _mtime: vstat(f, 'mtime'),
    }))
    .sort((a, b) => b._mtime - a._mtime);
}

router.get('/videos', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  renderPage(req, res, 'pages/admin-videos', {
    pageJs: 'admin-videos',
    pageTitleKey: 'admin.t_media',
    bodyClass: 'on-admin',
    items: videoEntries(site.id),
    audioOn: audioEnabled(),
    success: req.query.success || null,
  });
});

// Delete one video. Basename-only + within-dir, and only when no post uses it:
// the same guardrails the image delete has.
router.post('/videos/delete', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ error: 'site' });
  const file = path.basename(String(req.body?.file || ''));
  if (!file || !VIDEO_EXT.test(file)) return res.status(400).json({ error: 'bad_file' });
  const entry = videoEntries(site.id).find(e => e.file === file);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  if (entry.usedCount) return res.status(409).json({ error: 'in_use' });
  try { fs.unlinkSync(path.join(REPLY_MEDIA_DIR, file)); } catch { /* already gone is gone */ }
  res.json({ ok: true });
});

router.post('/delete', requireGod, (req, res) => {
  if (!res.locals.site) return res.status(404).json({ ok: false, error: 'Site required' });
  const f = String(req.body.file || '');
  if (!f || path.basename(f) !== f || !IMG_EXT.test(f)) return res.status(400).json({ ok: false, error: 'Bad file' });
  const stem = f.replace(/\.[^.]+$/, '');
  let removed = 0;
  for (const name of [f, `${stem}-v.mp4`, `${stem}-v.jpg`]) {
    const full = path.join(POST_IMAGES_DIR, name);
    if (path.dirname(full) !== POST_IMAGES_DIR) continue;
    try { fs.unlinkSync(full); removed++; } catch { /* missing sibling */ }
  }
  res.json({ ok: true, removed });
});

// Delete every unused image (orphan) + its siblings.
router.post('/cleanup', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).json({ ok: false, error: 'Site required' });
  let removed = 0;
  for (const e of imageEntries(site.id)) {
    if (e.usedCount) continue; // still in use
    for (const name of [e.file, e.mp4, `${e.stem}-v.jpg`]) {
      try { fs.unlinkSync(path.join(POST_IMAGES_DIR, name)); removed++; } catch { /* */ }
    }
  }
  res.json({ ok: true, removed });
});

export default router;
