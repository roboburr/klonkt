// StatsService — cookievrije statistieken (premium-module).
//
// Tellers: posts.view_count, audio_tracks.play_count, en per dag/site het aantal
// pageviews (stat_daily) + unieke bezoekers (stat_visitor_day).
//
// Unieke bezoekers ZONDER cookie: een sha256 van IP+UA+dag-salt. De salt roteert
// elke dag en wordt nooit langer bewaard → je kunt iemand niet over dagen heen
// volgen, het ruwe IP wordt niet opgeslagen. Geen persistente identifier, geen
// toestemmingsbanner nodig (Plausible/Fathom-aanpak).

import crypto from 'node:crypto';
import db from '../config/database.js';
import { getSetting, setSetting } from './SettingsService.js';

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Dagelijks roterende salt (gecachet in proces, persistent in app_settings zodat
// een herstart binnen dezelfde dag dezelfde salt houdt).
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

// De eigenaar/beheerder niet meetellen — anders inflate je je eigen cijfers.
function isOperator(req) {
  const u = req && req.session && req.session.user;
  return !!(u && (u.role === 'god' || u.role === 'admin'));
}

// Lazy prepares — tabellen bestaan pas ná initializeDatabase(); dit module wordt
// geïmporteerd vóór die call.
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

// Externe referrer-host uit de Referer-header (pro-stats #5). Lege/eigen-site/
// ongeldige referrers worden overgeslagen → alleen echte externe bronnen tellen.
function recordReferrer(siteId, req) {
  try {
    const ref = req && req.headers && (req.headers.referer || req.headers.referrer);
    if (!ref) return;
    const host = new URL(ref).host.replace(/^www\./, '').toLowerCase();
    if (!host) return;
    const own = ((req.headers && req.headers.host) || '').replace(/^www\./, '').toLowerCase();
    if (host === own) return; // interne navigatie telt niet als bron
    stmts().bumpReferrer.run(siteId, host.slice(0, 120));
  } catch { /* geen geldige referrer-URL → overslaan */ }
}

export function recordPageview(siteId, req) {
  if (!siteId || isOperator(req)) return;
  try {
    const d = today();
    stmts().bumpDaily.run(siteId, d);
    stmts().addVisitor.run(siteId, d, visitorHash(req));
    recordReferrer(siteId, req);
  } catch { /* statistieken mogen nooit een request breken */ }
}

export function recordPostView(post, req) {
  if (!post || !post.id || isOperator(req)) return;
  try {
    stmts().bumpPost.run(post.id);
    recordPageview(post.site_id, req);
  } catch {}
}

export function recordPlay(trackId) {
  if (!trackId) return;
  try { stmts().bumpTrack.run(trackId); } catch {}
}

// Instance-brede statistieken (solo = de site, hub = alle sites samen).
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
    pageviews: series.reduce((s, r) => s + r.pageviews, 0), // laatste N dagen
    visitors: series.reduce((s, r) => s + r.visitors, 0),   // som van dag-uniques (cookieless kan niet anders)
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
  // Top externe bronnen (pro #5) — instance-breed geaggregeerd per host.
  let referrers = [];
  try {
    referrers = db.prepare(
      'SELECT host, SUM(count) AS n FROM stat_referrer GROUP BY host ORDER BY n DESC LIMIT 10'
    ).all();
  } catch { referrers = []; }
  // All-time totalen (cookieloze unieke bezoekers = som van dag-uniques).
  const allTime = {
    pageviews: db.prepare('SELECT COALESCE(SUM(pageviews),0) AS n FROM stat_daily').get().n,
    visitorDays: db.prepare('SELECT COUNT(*) AS n FROM stat_visitor_day').get().n,
  };
  return { totals, series, topPosts, topTracks, referrers, allTime, days };
}
