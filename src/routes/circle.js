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
// The cover image + (separately) a cover video from a remote note's media. NEVER use a video/audio
// item as the cover image — that produced a broken <img> for an animated cover that federated as an
// MP4 (the video becomes a <video> instead).
function coverMedia(media_json) {
  const media = safeJson(media_json).map((m) => ({ ...m, url: safeUrl(m.url) })).filter((m) => m.url);
  const video = media.find((m) => /video/i.test(m.type || '')) || null;
  const image = media.find((m) => /image/i.test(m.type || ''))
    || (media[0] && !/(video|audio)/i.test(media[0].type || '') ? media[0] : null);
  return { image, video };
}
function htmlToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
// Tidy a plain-text snippet for use as a card title: drop a leading "RE: <url>" (the
// quote/reply prefix Misskey/Akkoma and some reply federation prepend) and any other
// leading bare URL, so the title shows the actual prose, not link noise.
function tidySnippet(text) {
  return String(text || '')
    .replace(/^RE:\s*https?:\/\/\S+\s*/i, '')
    .replace(/^https?:\/\/\S+\s*/i, '')
    .trim();
}

router.get('/cirkel', (req, res, next) => {
  const site = res.locals.site;
  if (!site || !apEnabled() || (ActivityPubService.autoBoostCount(site.slug) === 0 && ActivityPubService.boostedCount(site.slug) === 0)) return next();

  const posts = ActivityPubService.getCirkelPosts(site.slug, 80).map((r) => {
    const text = tidySnippet(htmlToText(r.content));
    // Show ONLY the title (the bold first line a Klonkt note carries), not the whole
    // body. Title-less notes (e.g. plain Mastodon) fall back to a short text snippet.
    const titleM = (r.content || '').match(/^\s*<p>\s*<strong>([\s\S]*?)<\/strong>/i);
    const realTitle = titleM ? htmlToText(titleM[1]).trim() : '';
    const cover = coverMedia(r.media_json);
    const name = r.author_name || r.author_handle || 'Onbekend';
    return {
      id: 'ap-' + r.id,
      slug: '',
      title: realTitle
        ? (realTitle.length > 90 ? realTitle.slice(0, 90) + '…' : realTitle)
        : (text ? (text.length > 90 ? text.slice(0, 90) + '…' : text) : name),
      excerpt: '',
      cover_image_url: cover.image ? cover.image.url : null,
      cover_video_url: cover.video ? cover.video.url : null,
      published_at: r.published,
      created_at: r.published,
      type: 'post',
      tags: '',
      pinned: 0,
      isBoost: !!r.boosted, // a post YOU boosted → render in the pinned style with a Boost badge
      nsfw: r.nsfw ? 1 : 0, // remote sensitive post → blur in the Cirkel (post-card/tile)
      content_warning: r.cw || '',
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
