/**
 * Embedbare player (premium feature #7).
 *
 *   GET /embed   -> een zelfstandige, compacte audiospeler-pagina (geen shell),
 *                   bedoeld om op EXTERNE sites in een <iframe> te zetten.
 *
 * De pagina wordt door ons (klonkt-origin) geserveerd, dus de audio-requests vanuit
 * het iframe blijven same-origin → de /audio/stream-gate laat ze door, ook al staat
 * het iframe op een vreemde site. We overrulen alleen Helmet's frameguard +
 * frame-ancestors zodat externe sites mógen inbedden. Hub: /user/:slug/embed.
 */

import express from 'express';
import { premiumUnlocked } from '../services/PatreonService.js';

const router = express.Router();

router.get('/embed', (req, res, next) => {
  if (!premiumUnlocked()) return next();
  const site = res.locals.site;
  if (!site) return next();

  // Inbedden op externe sites toestaan (overrule de globale frameguard/CSP).
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
