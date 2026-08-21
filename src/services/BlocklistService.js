/**
 * The instance blocklist (ap_blocks): actors and whole domains a site has
 * blocked. Lives NEXT TO the guardianship module, not inside it, because it
 * is shared: Klonkt's own Block tab uses it, and Shaer's "in Orbit" reads it
 * as the source of truth (AP §5.6 blocked collection, owner-only).
 *
 * Extracted from ActivityPubService (guardianship refactor); behavior is
 * unchanged. ActivityPubService re-exports these under the old names so
 * existing callers keep working.
 */
import db from '../config/database.js';

let _insBl, _delBl, _listBl;
function blStmts() {
  if (!_insBl) {
    _insBl = db.prepare('INSERT OR IGNORE INTO ap_blocks (slug, target, kind, label, created_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)');
    _delBl = db.prepare('DELETE FROM ap_blocks WHERE slug = ? AND target = ?');
    _listBl = db.prepare('SELECT * FROM ap_blocks WHERE slug = ? ORDER BY created_at DESC');
  }
  return { ins: _insBl, del: _delBl, list: _listBl };
}

export function listBlocks(slug) { return blStmts().list.all(slug); }

// True if an actor (or its whole domain) is blocked anywhere on this instance.
export function isBlockedAny(actorUri) {
  if (!actorUri) return false;
  let domain = ''; try { domain = new URL(actorUri).host; } catch { /* ignore */ }
  try { return !!db.prepare("SELECT 1 FROM ap_blocks WHERE (kind='actor' AND target=?) OR (kind='domain' AND target=?) LIMIT 1").get(actorUri, domain); }
  catch { return false; }
}

function purgeBlocked(kind, target) {
  try {
    if (kind === 'domain') {
      // Exact host match (a URL LIKE over-/under-matches: it misses bare-domain or :port
      // actor URIs and can catch look-alikes). Filter by parsed host, same as isBlockedAny.
      const purge = (table, col) => {
        let rows = [];
        try { rows = db.prepare(`SELECT DISTINCT ${col} AS u FROM ${table} WHERE ${col} IS NOT NULL AND ${col} != ''`).all(); } catch { return; }
        const del = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`);
        for (const r of rows) { let h = ''; try { h = new URL(r.u).host; } catch { /* skip */ } if (h === target) { try { del.run(r.u); } catch { /* ignore */ } } }
      };
      purge('ap_interactions', 'actor_uri');
      purge('ap_timeline', 'author_uri');
      purge('ap_followers', 'actor_uri');
    } else {
      db.prepare('DELETE FROM ap_interactions WHERE actor_uri = ?').run(target);
      db.prepare('DELETE FROM ap_timeline WHERE author_uri = ?').run(target);
      db.prepare('DELETE FROM ap_followers WHERE actor_uri = ?').run(target);
    }
  } catch { /* best-effort */ }
}

// Block an actor (@handle or actor URL) or a whole domain; purges their content.
// `resolveHandle` (async handle → actor URL) is injected by the caller so this
// service needs nothing from ActivityPubService (no circular import).
/**
 * Een blokkade is pas een blokkade als de ander het merkt (Robin, 21-8).
 *
 * Tot vandaag bleef hij binnenshuis: rij in ap_blocks, inhoud opruimen, volger
 * eruit -- en verder niets. De andere kant volgde je dan nog steeds in zijn
 * eigen boeken en bleef je publieke outbox lezen. Precies wat de hub deed:
 * kanaal en berichten stonden er gewoon nog. Vandaar dat we het nu ook
 * VERSTUREN, zoals Mastodon dat doet: een Block naar de inbox van wie je
 * blokkeert, en bij opheffen een Undo(Block) zodat de weg terug openligt.
 *
 * Alleen voor een actor-blokkade: een heel domein heeft geen inbox om aan te
 * schrijven. En bezorgen mag nooit de blokkade zelf tegenhouden -- die staat
 * al vast in de database voordat we ook maar iets proberen te versturen.
 */
async function meldBlokkade(site, target, kind, bezorg, undo = false) {
  if (kind !== 'actor' || typeof bezorg !== 'function') return;
  try { await bezorg(site, target, undo); } catch { /* de blokkade staat, de melding is een gunst */ }
}

export async function blockTarget(site, input, resolveHandle, bezorg) {
  const raw = String(input || '').trim();
  if (!site || !site.slug || !raw) return { error: 'empty' };
  let kind, target, label;
  if (/^https?:\/\//i.test(raw)) { kind = 'actor'; target = raw; label = raw; }
  else if (raw.includes('@')) {
    const actorUrl = resolveHandle ? await resolveHandle(raw) : null;
    if (!actorUrl) return { error: 'not_found' };
    kind = 'actor'; target = actorUrl; label = raw.startsWith('@') ? raw : ('@' + raw);
  } else { kind = 'domain'; target = raw.toLowerCase(); label = raw.toLowerCase(); }
  blStmts().ins.run(site.slug, target, kind, label);
  purgeBlocked(kind, target);
  console.log('[AP] block', site.slug, kind, target);
  await meldBlokkade(site, target, kind, bezorg);
  return { ok: true, label };
}

export async function unblock(site, target, bezorg) {
  const rij = blStmts().list.all(site.slug).find((b) => b.target === target);
  blStmts().del.run(site.slug, target);
  // Undo(Block) zodat de ander weet dat de deur weer open is; zonder dit blijft
  // hij bij zichzelf geblokkeerd staan en komt hij nooit terug.
  await meldBlokkade(site, target, (rij && rij.kind) || 'actor', bezorg, true);
  return { ok: true };
}

export default { listBlocks, isBlockedAny, blockTarget, unblock };
