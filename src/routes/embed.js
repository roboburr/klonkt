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

  const tracks = (res.locals.audioTracks || []).map((t) => ({
    id: t.id, title: t.title, artist: t.artist, duration: t.duration, url: t.media_url,
  })).filter((t) => t.url);

  res.render('pages/embed-player', {
    site,
    embedTracks: tracks,
    siteUrlBase: res.locals.siteUrlBase || '',
  });
});

export default router;
