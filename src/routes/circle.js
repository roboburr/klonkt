/**
 * Circle feed — the artists this site features (auto-boosts), sourced from
 * ActivityPub. Cards link to the source post. Available whenever the site
 * auto-boosts at least one account; otherwise next() -> postsRoutes.
 *   GET /cirkel
 */

import express from 'express';
import { renderPage } from '../middleware/render.js';
import { apEnabled } from '../services/SettingsService.js';
import ActivityPubService from '../services/ActivityPubService.js';

const router = express.Router();

function safeUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null;
}
function safeJson(s) {
  try { return s ? JSON.parse(s) : []; } catch { return []; }
}
function mediaImage(media_json) {
  const media = safeJson(media_json).map((m) => ({ ...m, url: safeUrl(m.url) })).filter((m) => m.url);
  return media.find((m) => /image/i.test(m.type || '')) || media[0] || null;
}
function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

router.get('/cirkel', (req, res, next) => {
  const site = res.locals.site;
  if (!site || !apEnabled() || ActivityPubService.autoBoostCount(site.slug) === 0) return next();

  const posts = ActivityPubService.getCirkelPosts(site.slug, 80).map((r) => {
    const text = htmlToText(r.content);
    const image = mediaImage(r.media_json);
    const name = r.author_name || r.author_handle || 'Onbekend';
    return {
      id: 'ap-' + r.id,
      slug: '',
      title: text ? (text.length > 90 ? text.slice(0, 90) + '…' : text) : name,
      excerpt: '',
      cover_image_url: image ? image.url : null,
      published_at: r.published,
      created_at: r.published,
      type: 'post',
      tags: '',
      pinned: 0,
      status: 'published',
      source_name: name,
      external_url: safeUrl(r.url),
    };
  });

  const sites = ActivityPubService.getCirkelMembers(site.slug)
    .map((s) => ({ name: s.name || 'Onbekend', url: safeUrl(s.url), avatar: safeUrl(s.icon) }));

  renderPage(req, res, 'pages/circle-feed', { pageTitle: 'Cirkel', bodyClass: 'on-cirkel', posts, sites });
});

export default router;
