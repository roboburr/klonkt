/**
 * Embeddable player (premium feature #7).
 *
 *   GET /embed   -> a standalone, compact audio player page (no shell),
 *                   intended to be placed in an <iframe> on EXTERNAL sites.
 *
 * The page is served by us (klonkt-origin), so audio requests from within
 * the iframe remain same-origin → the /audio/stream gate lets them through,
 * even when the iframe is on a foreign site. We only override Helmet's frameguard
 * + frame-ancestors so that external sites are allowed to embed us. Hub: /user/:slug/embed.
 */

import express from 'express';
import db from '../config/database.js';
import { premiumUnlocked } from '../services/PatreonService.js';

const router = express.Router();

router.get('/embed', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();

  // Allow embedding on external sites (override the global frameguard/CSP).
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; media-src 'self' blob: https:; img-src 'self' data: https:; style-src 'unsafe-inline'; script-src 'unsafe-inline' 'self'; frame-ancestors *",
  );

  let tracks = (res.locals.audioTracks || []).map((t) => ({
    id: t.id, title: t.title, artist: t.artist, duration: t.duration, url: t.media_url,
  })).filter((t) => t.url);

  // ?post=<slug> → scope the player to that post's tracks (for the fediverse
  // player card). Resolve [[track]]/[[album]]/[[playlist]] shortcodes → track ids.
  const postSlug = (req.query.post || '').toString();
  if (postSlug) {
    try {
      const post = db.prepare("SELECT content FROM posts WHERE site_id = ? AND slug = ? AND status = 'published'").get(site.id, postSlug);
      if (post && post.content) {
        const ids = []; const seen = new Set();
        const add = (id) => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
        for (const m of post.content.matchAll(/\[\[track:([A-Za-z0-9_-]+)\]\]/g)) add(m[1]);
        for (const m of post.content.matchAll(/\[\[album:([^\]]+)\]\]/g)) for (const r of db.prepare('SELECT id FROM audio_tracks WHERE site_id = ? AND album = ? ORDER BY position').all(site.id, m[1].trim())) add(r.id);
        for (const m of post.content.matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) for (const r of db.prepare('SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position').all(m[1])) add(r.track_id);
        if (ids.length) {
          const byId = new Map(tracks.map((t) => [t.id, t]));
          const scoped = ids.map((id) => byId.get(id)).filter(Boolean);
          if (scoped.length) tracks = scoped;
        }
      }
    } catch { /* fall back to the full site player */ }
  }

  res.render('pages/embed-player', {
    site,
    embedTracks: tracks,
    siteUrlBase: res.locals.siteUrlBase || '',
  });
});

export default router;
