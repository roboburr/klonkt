// CircleService.js — pull-kant van Cirkels (v1).
//
// Haalt per circle_link de remote actor + outbox op, verifieert de Ed25519-
// handtekening, sanitiseert en cachet publieke posts in remote_actors/remote_posts.
// Alleen LEZEN van remote; nooit schrijven. Zie docs/cirkels-v1-spec.md §5b.

import db from '../config/database.js';
import { verifyBody, KLONKT_PROTO, MIN_PROTO } from './CircleFederation.js';
import { getTenancy } from './SettingsService.js';

const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const MAX_ITEMS = 50;

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')   // [[playlist:..]]/[[track:..]]/[[album:..]]-shortcodes weg
    .replace(/\s+/g, ' ')
    .trim();
}
function iso(d) {
  const t = d ? new Date(d) : null;
  return t && !isNaN(t.getTime()) ? t.toISOString() : null;
}
function originOf(u) {
  try { return new URL(u).origin; } catch { return null; }
}
function baseOf(remoteUrl) {
  return String(remoteUrl).replace(/\/+$/, '');
}

// AS Hashtag-array -> comma-separated tagnamen (zonder #), gesanitized.
function extractTags(tag) {
  if (!Array.isArray(tag)) return null;
  const names = tag
    .map((t) => String((t && t.name) || '').replace(/^#/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  return names.length ? names.join(', ') : null;
}

// Bron buiten de cirkel zetten met een leesbare reden (geen stille mislukking).
// Aparte status 'outdated' zodat de Beheer-UI er een nette "update vereist"-
// melding van kan maken i.p.v. een generieke fout.
function markOutdated(link, msg) {
  // Gecachte posts van deze bron weghalen: we kunnen ze niet meer verifiëren of
  // verversen (proto-mismatch), dus ze horen niet meer in de cirkel-feed.
  if (link.remote_actor_id) {
    try { db.prepare('DELETE FROM remote_posts WHERE actor_id = ?').run(link.remote_actor_id); } catch {}
  }
  db.prepare("UPDATE circle_links SET status='outdated', last_error=?, last_synced=CURRENT_TIMESTAMP WHERE id=?")
    .run(String(msg).slice(0, 300), link.id);
  return { ok: false, outdated: true, link: link.remote_url, error: msg };
}

// Robuuste, defensieve fetch: alleen https, timeout, body-cap, redirect-follow.
async function fetchText(url) {
  if (!/^https:\/\//i.test(url)) throw new Error('alleen https toegestaan');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        Accept: 'application/activity+json, application/json',
        // Vertel de publisher onze proto → die kan ons met 426 weren als we te oud zijn.
        'Klonkt-Proto': String(KLONKT_PROTO),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) throw new Error('body te groot');
    return { text: buf.toString('utf8'), headers: res.headers, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

// Lazy prepares — de tabellen bestaan pas ná initializeDatabase(); dit module
// wordt geïmporteerd vóór die call, dus niet op module-niveau prepare'n.
let _stmts = null;
function stmts() {
  if (_stmts) return _stmts;
  _stmts = {
    upsertActor: db.prepare(`
      INSERT INTO remote_actors (id, url, name, summary, avatar, public_key, fetched_at)
      VALUES (@id, @url, @name, @summary, @avatar, @public_key, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        url=excluded.url, name=excluded.name, summary=excluded.summary,
        avatar=excluded.avatar, public_key=excluded.public_key, fetched_at=CURRENT_TIMESTAMP
    `),
    upsertPost: db.prepare(`
      INSERT INTO remote_posts (id, actor_id, published, title, summary, url, media_json, tags, raw_json, fetched_at)
      VALUES (@id, @actor_id, @published, @title, @summary, @url, @media_json, @tags, @raw_json, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        published=excluded.published, title=excluded.title, summary=excluded.summary,
        url=excluded.url, media_json=excluded.media_json, tags=excluded.tags,
        raw_json=excluded.raw_json, fetched_at=CURRENT_TIMESTAMP
    `),
  };
  return _stmts;
}

export async function syncOne(link) {
  const base = baseOf(link.remote_url);

  // 1. Actor ophalen + valideren
  const actorUrl = `${base}/.klonkt/actor.json`;
  const a = await fetchText(actorUrl);
  let actor;
  try { actor = JSON.parse(a.text); } catch { throw new Error('actor: ongeldige JSON'); }
  const actorId = actor.id;
  const pubKey = actor.publicKey && actor.publicKey.publicKeyBase64;
  if (!actorId || !pubKey) throw new Error('actor mist id/publicKey');
  if (originOf(actorId) !== originOf(actorUrl)) throw new Error('actor.id heeft andere origin dan de actor-URL');

  // Protocol-versie-gate. De proto zit óók in de outbox-handtekening-grondslag,
  // dus liegen in de (ongetekende) actor helpt niet: bij een echte mismatch faalt
  // de verificatie verderop alsnog. Hier vooral voor een DUIDELIJKE melding +
  // buitensluiten zonder stille mislukking.
  const remoteProto = Number(actor.klonkt && actor.klonkt.proto) || 1;
  if (remoteProto > KLONKT_PROTO) {
    return markOutdated(link,
      `Deze site draait een nieuwere Klonkt (proto ${remoteProto}); jouw instance is proto ${KLONKT_PROTO}. Werk je eigen Klonkt bij om te blijven federeren.`);
  }
  if (remoteProto < MIN_PROTO) {
    return markOutdated(link,
      `Draait een oudere Klonkt (proto ${remoteProto}; minimaal ${MIN_PROTO} vereist). Vraag ze te updaten.`);
  }

  // TOFU: een sleutelwissel vereist expliciete herbevestiging (anti-hijack)
  const existing = db.prepare('SELECT public_key FROM remote_actors WHERE id = ?').get(actorId);
  if (existing && existing.public_key !== pubKey) {
    throw new Error('publieke sleutel gewijzigd — herbevestiging vereist (TOFU)');
  }

  stmts().upsertActor.run({
    id: actorId,
    url: actor.url || base,
    name: actor.name || null,
    summary: actor.summary || null,
    avatar: (actor.icon && actor.icon.url) || null,
    public_key: pubKey,
  });

  // 2. Outbox ophalen + handtekening verifiëren
  const outboxUrl = actor.outbox || `${base}/.klonkt/outbox.json`;
  const o = await fetchText(outboxUrl);
  const sigHeader = o.headers.get('klonkt-signature') || '';
  const sig = (sigHeader.match(/ed25519=(.+)\s*$/) || [])[1];
  if (!sig || !verifyBody(o.text, sig, pubKey, remoteProto)) {
    throw new Error('outbox-handtekening ongeldig of ontbreekt');
  }
  let outbox;
  try { outbox = JSON.parse(o.text); } catch { throw new Error('outbox: ongeldige JSON'); }
  const items = Array.isArray(outbox.orderedItems) ? outbox.orderedItems.slice(0, MAX_ITEMS) : [];

  // 3. Objecten sanitizen + cachen (same-origin als de actor = anti-impersonatie)
  const actorOrigin = originOf(actorId);
  const seen = new Set();
  for (const it of items) {
    const obj = it && it.object;
    if (!obj || !obj.id) continue;
    if (originOf(obj.id) !== actorOrigin) continue;
    const media = [];
    if (obj.image && obj.image.url) media.push({ type: 'image', url: obj.image.url });
    if (Array.isArray(obj.attachment)) {
      for (const att of obj.attachment) {
        if (att && att.url) media.push({ type: String(att.type || 'link').toLowerCase(), url: att.url, name: att.name, duration: att.duration });
      }
    }
    stmts().upsertPost.run({
      id: obj.id,
      actor_id: actorId,
      published: iso(obj.published || it.published),
      title: stripHtml(obj.name).slice(0, 300) || '(zonder titel)',
      summary: stripHtml(obj.summary || obj.content).slice(0, 1000),
      url: obj.url || obj.id,
      media_json: media.length ? JSON.stringify(media) : null,
      tags: extractTags(obj.tag),
      raw_json: JSON.stringify(obj).slice(0, 20000),
    });
    seen.add(obj.id);
  }

  // 4. Pruning: posts die niet meer in de outbox staan opruimen
  const known = db.prepare('SELECT id FROM remote_posts WHERE actor_id = ?').all(actorId).map((r) => r.id);
  const stale = known.filter((id) => !seen.has(id));
  if (stale.length) {
    const del = db.prepare('DELETE FROM remote_posts WHERE id = ?');
    db.transaction((ids) => ids.forEach((id) => del.run(id)))(stale);
  }

  db.prepare(
    "UPDATE circle_links SET remote_actor_id=?, last_synced=CURRENT_TIMESTAMP, status='active', last_error=NULL WHERE id=?"
  ).run(actorId, link.id);

  return { ok: true, actorId, items: seen.size, pruned: stale.length };
}

export async function sync() {
  if (getTenancy() !== 'circle') return { skipped: 'tenancy != circle' };
  const links = db.prepare("SELECT * FROM circle_links WHERE status != 'paused'").all();
  const results = [];
  for (const link of links) {
    try {
      results.push(await syncOne(link));
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      db.prepare("UPDATE circle_links SET status='error', last_error=?, last_synced=CURRENT_TIMESTAMP WHERE id=?")
        .run(msg, link.id);
      results.push({ ok: false, link: link.remote_url, error: msg });
    }
  }
  return { synced: results.length, results };
}

let _timer = null;
/** Periodieke achtergrond-sync (gated op tenancy='circle' binnen sync()). */
export function startCircleSyncLoop(intervalMs = 15 * 60 * 1000) {
  if (_timer) return;
  const run = () => { sync().catch((e) => console.error('[cirkels] sync-fout:', e.message)); };
  setTimeout(run, 30 * 1000); // korte delay na boot
  _timer = setInterval(run, intervalMs);
  if (_timer.unref) _timer.unref();
}
