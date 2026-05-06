/**
 * RSS / Atom feeds + sitemap.xml
 *
 * GET /feed.xml      -> RSS 2.0
 * GET /atom.xml      -> Atom 1.0
 * GET /sitemap.xml   -> XML sitemap (only if site.robots_index is on)
 *
 * All are site-scoped (using res.locals.site) and only include
 * status='published' posts.
 */

import express from 'express';
import db from '../config/database.js';

const router = express.Router();

function escapeXml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function siteOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

function postsForFeed(siteId, limit = 30) {
  return db.prepare(`
    SELECT p.id, p.slug, p.title, p.excerpt, p.content, p.published_at, p.updated_at,
           u.username AS author_username, u.email AS author_email
    FROM posts p JOIN users u ON u.id = p.author_id
    WHERE p.site_id = ? AND p.status = 'published'
    ORDER BY p.published_at DESC
    LIMIT ?
  `).all(siteId, limit);
}

// ==================== RSS 2.0 ====================
router.get('/feed.xml', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const origin = siteOrigin(req);
  const base = origin + (res.locals.siteUrlBase || '');
  const posts = postsForFeed(site.id);
  const lastBuild = posts[0]?.published_at || new Date().toISOString();

  res.set('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(site.title)}</title>
    <link>${escapeXml(base + '/')}</link>
    <description>${escapeXml(site.description || site.tagline || '')}</description>
    <language>${escapeXml(site.language || 'nl')}</language>
    <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(base + '/feed.xml')}" rel="self" type="application/rss+xml" />
${posts.map(p => `    <item>
      <title>${escapeXml(p.title || '(untitled)')}</title>
      <link>${escapeXml(base + '/' + p.slug)}</link>
      <guid isPermaLink="true">${escapeXml(base + '/' + p.slug)}</guid>
      <pubDate>${new Date(p.published_at).toUTCString()}</pubDate>
      <author>${escapeXml((p.author_email || 'noreply@localhost') + ' (' + p.author_username + ')')}</author>
      <description>${escapeXml(p.excerpt || '')}</description>
    </item>`).join('\n')}
  </channel>
</rss>`);
});

// ==================== Atom 1.0 ====================
router.get('/atom.xml', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  const origin = siteOrigin(req);
  const base = origin + (res.locals.siteUrlBase || '');
  const posts = postsForFeed(site.id);
  const updated = posts[0]?.updated_at || posts[0]?.published_at || new Date().toISOString();

  res.set('Content-Type', 'application/atom+xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(site.title)}</title>
  <link href="${escapeXml(base + '/')}" />
  <link href="${escapeXml(base + '/atom.xml')}" rel="self" />
  <id>${escapeXml(base + '/')}</id>
  <updated>${new Date(updated).toISOString()}</updated>
  <subtitle>${escapeXml(site.description || site.tagline || '')}</subtitle>
${posts.map(p => `  <entry>
    <title>${escapeXml(p.title || '(untitled)')}</title>
    <link href="${escapeXml(base + '/' + p.slug)}" />
    <id>${escapeXml(base + '/' + p.slug)}</id>
    <updated>${new Date(p.updated_at || p.published_at).toISOString()}</updated>
    <published>${new Date(p.published_at).toISOString()}</published>
    <author><name>${escapeXml(p.author_username)}</name></author>
    <summary>${escapeXml(p.excerpt || '')}</summary>
  </entry>`).join('\n')}
</feed>`);
});

// ==================== Sitemap.xml ====================
router.get('/sitemap.xml', (req, res) => {
  const site = res.locals.site;
  if (!site) return res.status(404).send('No site');

  // Honour the per-site robots_index flag.
  if (site.robots_index === 0) {
    res.set('X-Robots-Tag', 'noindex');
    return res.status(404).send('No sitemap');
  }

  const origin = siteOrigin(req);
  const base = origin + (res.locals.siteUrlBase || '');
  const posts = db.prepare(`
    SELECT slug, COALESCE(updated_at, published_at) AS lastmod
    FROM posts
    WHERE site_id = ? AND status = 'published'
    ORDER BY lastmod DESC
    LIMIT 1000
  `).all(site.id);

  const urls = [
    { loc: base + '/', lastmod: posts[0]?.lastmod, priority: '1.0' },
    { loc: base + '/archive', priority: '0.7' },
    ...posts.map(p => ({
      loc: base + '/' + p.slug,
      lastmod: p.lastmod,
      priority: '0.8',
    })),
  ];

  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${escapeXml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${new Date(u.lastmod).toISOString().slice(0,10)}</lastmod>` : ''}
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`);
});

export default router;
