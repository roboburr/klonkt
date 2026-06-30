// StatsService — cookie-free statistics (premium module).
//
// Counters: posts.view_count, audio_tracks.play_count, and per day/site the number
// of pageviews (stat_daily) + unique visitors (stat_visitor_day).
//
// Unique visitors WITHOUT cookies: a sha256 of IP+UA+daily-salt. The salt rotates
// every day and is never stored longer → you cannot track someone across days,
// and the raw IP is never persisted. No persistent identifier, no consent
// banner required (Plausible/Fathom approach).

import crypto from 'node:crypto';
import db from '../config/database.js';
import { getSetting, setSetting } from './SettingsService.js';

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Daily rotating salt (cached in process, persisted in app_settings so that
// a restart within the same day reuses the same salt).
let _salt = null, _saltDay = null;
function dailySalt() {
  const d = today();
  if (_salt && _saltDay === d) return _salt;
  let stored = getSetting('stat_salt', null);
  if (!stored || getSetting('stat_salt_day', null) !== d) {
    stored = crypto.randomBytes(16).toString('hex');
    setSetting('stat_salt', stored);
    setSetting('stat_salt_day', d);
  }
  _salt = stored; _saltDay = d;
  return stored;
}

function visitorHash(req) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
  const ua = (req && req.headers && req.headers['user-agent']) || '';
  return crypto.createHash('sha256').update(dailySalt() + '|' + ip + '|' + ua).digest('hex').slice(0, 32);
}

// Don't count the owner/admin — otherwise you inflate your own numbers.
function isOperator(req) {
  const u = req && req.session && req.session.user;
  return !!(u && (u.role === 'god' || u.role === 'admin'));
}

// Skip known bots/crawlers + link-preview fetchers + scripts so they don't inflate
// view/visitor-day counts. Empty UA = almost always automated.
const BOT_RE = /bot|crawl|spider|slurp|mediapartners|bingpreview|facebookexternalhit|whatsapp|telegram|discord|twitter|linkedin|embedly|pinterest|redditbot|applebot|petalbot|yandex|baidu|duckduckbot|semrush|ahrefs|mj12|dotbot|uptimerobot|pingdom|statuscake|headless|lighthouse|gptbot|claude|ccbot|perplexity|bytespider|amazonbot|googleother|google-read-aloud|python-requests|scrapy|curl|wget|axios|node-fetch|go-http|java\/|okhttp|libwww|httpclient/i;
function isBot(req) {
  const ua = (req && req.headers && req.headers['user-agent']) || '';
  if (!ua) return true;          // empty UA = script/bot
  return BOT_RE.test(ua);
}

// The client IP (trust-proxy gives the real one), normalised: drop an IPv4-mapped-IPv6 prefix
// and a trailing :port so it matches what the admin sees + stores.
function clientIp(req) {
  let ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.split(':')[0];
  return ip;
}
export function currentIp(req) { return clientIp(req); }

// Admin-configured IPs to skip — so an owner browsing logged-OUT (incognito, another browser)
// doesn't inflate their own stats. Stored as a comma-separated app_setting.
export function getExcludedIps() {
  return (getSetting('stats_exclude_ips', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
}
export function setExcludedIps(list) {
  const clean = [...new Set((list || []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 20);
  setSetting('stats_exclude_ips', clean.join(','));
}
function isExcludedIp(req) {
  try { const ip = clientIp(req); return !!ip && getExcludedIps().includes(ip); } catch { return false; }
}

// Lazy prepares — tables only exist after initializeDatabase(); this module is
// imported before that call.
let _s = null;
function stmts() {
  if (_s) return _s;
  _s = {
    bumpDaily: db.prepare(`
      INSERT INTO stat_daily (site_id, day, pageviews) VALUES (?, ?, 1)
      ON CONFLICT(site_id, day) DO UPDATE SET pageviews = pageviews + 1
    `),
    addVisitor: db.prepare('INSERT OR IGNORE INTO stat_visitor_day (site_id, day, visitor_hash) VALUES (?, ?, ?)'),
    bumpPost: db.prepare('UPDATE posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?'),
    bumpTrack: db.prepare('UPDATE audio_tracks SET play_count = COALESCE(play_count, 0) + 1 WHERE id = ?'),
    bumpReferrer: db.prepare(`
      INSERT INTO stat_referrer (site_id, host, count) VALUES (?, ?, 1)
      ON CONFLICT(site_id, host) DO UPDATE SET count = count + 1
    `),
  };
  return _s;
}

// External referrer host from the Referer header (pro stats #5). Empty/own-site/
// invalid referrers are skipped → only genuine external sources are counted.
function recordReferrer(siteId, req) {
  try {
    const ref = req && req.headers && (req.headers.referer || req.headers.referrer);
    if (!ref) return;
    const host = new URL(ref).host.replace(/^www\./, '').toLowerCase();
    if (!host) return;
    const own = ((req.headers && req.headers.host) || '').replace(/^www\./, '').toLowerCase();
    if (host === own) return; // internal navigation does not count as a source
    stmts().bumpReferrer.run(siteId, host.slice(0, 120));
  } catch { /* not a valid referrer URL → skip */ }
}

export function recordPageview(siteId, req) {
  if (!siteId || isOperator(req) || isBot(req) || isExcludedIp(req)) return;
  try {
    const d = today();
    stmts().bumpDaily.run(siteId, d);
    stmts().addVisitor.run(siteId, d, visitorHash(req));
    recordReferrer(siteId, req);
  } catch { /* stats must never break a request */ }
}

export function recordPostView(post, req) {
  if (!post || !post.id || isOperator(req) || isBot(req) || isExcludedIp(req)) return;
  try {
    stmts().bumpPost.run(post.id);
    recordPageview(post.site_id, req);
  } catch {}
}

export function recordPlay(trackId) {
  if (!trackId) return;
  try { stmts().bumpTrack.run(trackId); } catch {}
}

// Instance-wide statistics (solo = the site, hub = all sites combined).
export function getStats(days = 14) {
  days = [7, 14, 30, 90].includes(Number(days)) ? Number(days) : 14;
  const pvMap = Object.fromEntries(
    db.prepare('SELECT day, SUM(pageviews) AS pv FROM stat_daily GROUP BY day').all().map((r) => [r.day, r.pv]),
  );
  const visMap = Object.fromEntries(
    db.prepare('SELECT day, COUNT(*) AS v FROM stat_visitor_day GROUP BY day').all().map((r) => [r.day, r.v]),
  );
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date();
    dt.setUTCDate(dt.getUTCDate() - i);
    const d = dt.toISOString().slice(0, 10);
    series.push({ day: d, pageviews: pvMap[d] || 0, visitors: visMap[d] || 0 });
  }
  const totals = {
    pageviews: series.reduce((s, r) => s + r.pageviews, 0), // last N days
    visitors: series.reduce((s, r) => s + r.visitors, 0),   // sum of daily uniques (cookieless has no alternative)
    plays: db.prepare('SELECT COALESCE(SUM(play_count), 0) AS n FROM audio_tracks').get().n,
    postViews: db.prepare('SELECT COALESCE(SUM(view_count), 0) AS n FROM posts').get().n,
  };
  const topPosts = db.prepare(`
    SELECT title, slug, COALESCE(view_count, 0) AS views FROM posts
    WHERE status = 'published' ORDER BY view_count DESC, published_at DESC LIMIT 5
  `).all();
  const topTracks = db.prepare(`
    SELECT title, COALESCE(play_count, 0) AS plays FROM audio_tracks
    ORDER BY play_count DESC LIMIT 5
  `).all();
  // Top external sources (pro #5) — aggregated instance-wide per host.
  let referrers = [];
  try {
    referrers = db.prepare(
      'SELECT host, SUM(count) AS n FROM stat_referrer GROUP BY host ORDER BY n DESC LIMIT 10'
    ).all();
  } catch { referrers = []; }
  // All-time totals (cookieless unique visitors = sum of daily uniques).
  const allTime = {
    pageviews: db.prepare('SELECT COALESCE(SUM(pageviews),0) AS n FROM stat_daily').get().n,
    visitorDays: db.prepare('SELECT COUNT(*) AS n FROM stat_visitor_day').get().n,
  };
  return { totals, series, topPosts, topTracks, referrers, allTime, days };
}
