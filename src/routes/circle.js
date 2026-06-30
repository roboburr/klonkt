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
  if (!site || !apEnabled() || (ActivityPubService.autoBoostCount(site.slug) === 0 && ActivityPubService.boostedCount(site.slug) === 0)) return next();

  const members = ActivityPubService.getCirkelMembers(site.slug);
  // Optional ?actor=<uri> → show only that member's posts. Only honour a uri that is
  // actually a featured member (so it can't be used to probe arbitrary timeline rows).
  const reqActor = safeUrl(req.query.actor);
  const activeMember = reqActor ? members.find((m) => m.actor_uri === reqActor) : null;
  const activeActor = activeMember ? activeMember.actor_uri : null;

  const posts = ActivityPubService.getCirkelPosts(site.slug, 80, activeActor).map((r) => {
    const text = htmlToText(r.content);
    // Show ONLY the title (the bold first line a Klonkt note carries), not the whole
    // body. Title-less notes (e.g. plain Mastodon) fall back to a short text snippet.
    const titleM = (r.content || '').match(/^\s*<p>\s*<strong>([\s\S]*?)<\/strong>/i);
    const realTitle = titleM ? htmlToText(titleM[1]).trim() : '';
    const image = mediaImage(r.media_json);
    const name = r.author_name || r.author_handle || 'Onbekend';
    return {
      id: 'ap-' + r.id,
      slug: '',
      title: realTitle
        ? (realTitle.length > 90 ? realTitle.slice(0, 90) + '…' : realTitle)
        : (text ? (text.length > 90 ? text.slice(0, 90) + '…' : text) : name),
      excerpt: '',
      cover_image_url: image ? image.url : null,
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

  const sites = members.map((s) => ({
    name: s.name || 'Onbekend', url: safeUrl(s.url), avatar: safeUrl(s.icon),
    actor_uri: s.actor_uri, active: !!(activeActor && s.actor_uri === activeActor),
  }));

  renderPage(req, res, 'pages/circle-feed', {
    pageTitle: 'Cirkel', bodyClass: 'on-cirkel', posts, sites,
    activeActor, activeName: activeMember ? (activeMember.name || '') : '',
  });
});

export default router;
