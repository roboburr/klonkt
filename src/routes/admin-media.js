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
import { fileURLToPath } from 'url';
import db from '../config/database.js';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { audioEnabled } from '../config/features.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POST_IMAGES_DIR = path.resolve(
  process.env.POST_IMAGES_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'post-images')
);

const router = express.Router();

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
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

router.get('/', requireGod, (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('Site required');
  const used = usageMap(site.id);
  let all = [];
  try { all = fs.readdirSync(POST_IMAGES_DIR).filter(f => !f.startsWith('.')); } catch { /* dir may not exist yet */ }
  const present = new Set(all);
  const items = all
    .filter(f => IMG_EXT.test(f) && !isSibling(f))
    .map(f => {
      const stem = f.replace(/\.[^.]+$/, '');
      const mp4 = `${stem}-v.mp4`;
      const hasVideo = present.has(mp4);
      const ids = new Set([...(used.get(f) || []), ...(hasVideo ? (used.get(mp4) || []) : [])]);
      return {
        file: f,
        url: `/media/post-images/${f}`,
        kb: Math.round((statSize(f) + (hasVideo ? statSize(mp4) : 0)) / 1024),
        hasVideo,
        usedCount: ids.size,
        _mtime: statMtime(f),
      };
    })
    .sort((a, b) => b._mtime - a._mtime); // newest first
  renderPage(req, res, 'pages/admin-media', {
    pageTitleKey: 'admin.t_media',
    bodyClass: 'on-admin',
    items,
    unusedCount: items.filter(i => !i.usedCount).length,
    audioOn: audioEnabled(),
    success: req.query.success || null,
  });
});

// Delete one image + its loop-MP4 / poster siblings. Basename-only + within-dir → no traversal.
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
  const used = usageMap(site.id);
  let all = [];
  try { all = fs.readdirSync(POST_IMAGES_DIR).filter(f => !f.startsWith('.')); } catch { /* */ }
  const present = new Set(all);
  let removed = 0;
  for (const f of all.filter(x => IMG_EXT.test(x) && !isSibling(x))) {
    const stem = f.replace(/\.[^.]+$/, '');
    const mp4 = `${stem}-v.mp4`;
    const ids = new Set([...(used.get(f) || []), ...(present.has(mp4) ? (used.get(mp4) || []) : [])]);
    if (ids.size) continue; // still in use
    for (const name of [f, mp4, `${stem}-v.jpg`]) {
      try { fs.unlinkSync(path.join(POST_IMAGES_DIR, name)); removed++; } catch { /* */ }
    }
  }
  res.json({ ok: true, removed });
});

export default router;
