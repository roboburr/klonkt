/**
 * ap-cirkel.js — de Cirkel (stap 10 van shaer-drc).
 *
 * De feed van uitgelichte accounts (auto_boost) plus zelf gebooste posts,
 * en de twee lijstjes eromheen. Leest ap_timeline, ap_following en
 * ap_my_reactions. Schrijft alleen de zichtbaarheid van oude rijen terug
 * (herkeurCirkel); het ophalen daarvoor krijgt hij van de aanroeper mee.
 *
 * DE CIRKEL IS OPENBAAR, en wat erop staat is van een ander (shaer-7jkp).
 * Wie we volgen, stuurt ons ook zijn vriendenposts -- die stonden hier dan
 * voor iedereen, met hun hele tekst. Dus alleen wat de afzender zelf openbaar
 * maakte: 'public', en 'unlisted' alleen als wij hem bewust boostten (een
 * uitgelicht account dat 'niet in openbare tijdlijnen' koos, zetten we er
 * niet zelf in). Wat we niet zeker weten, staat er niet.
 */
import db, { isoSql } from '../config/database.js';

// ── Cirkel = posts from the accounts you auto-boost ("feature an artist") ──
let _abCount, _cirkelPosts, _cirkelMembers;
export function autoBoostCount(slug) {
  try { if (!_abCount) _abCount = db.prepare('SELECT COUNT(*) AS n FROM ap_following WHERE slug = ? AND auto_boost = 1'); return _abCount.get(slug).n; } catch { return 0; }
}
export function getCirkelPosts(slug, limit, offset) {
  try {
    // Cirkel = posts from featured (auto_boost) accounts + posts you boosted
    // (t.boosted), mixed by date. One row per note in ap_timeline → no duplicates.
    if (!_cirkelPosts) _cirkelPosts = db.prepare(`
      SELECT t.id, t.author_uri, t.author_name, t.author_handle, t.author_icon, t.author_url,
             t.content, t.url, t.published, t.media_json, t.nsfw, t.cw,
             (rb.target_uri IS NOT NULL) AS boosted
      FROM ap_timeline t
      LEFT JOIN ap_following f ON f.slug = t.slug AND f.actor_uri = t.author_uri
      -- Uit de tussentabel, niet uit t.boosted: die kolom is een afgeleide. De
      -- UNIQUE(site_slug, target_uri, kind) garandeert hoogstens één match, dus
      -- deze join kan geen rijen verdubbelen.
      LEFT JOIN ap_my_reactions rb ON rb.site_slug = t.slug AND rb.target_uri = t.id AND rb.kind = 'boost'
      WHERE t.slug = ? AND (f.auto_boost = 1 OR rb.target_uri IS NOT NULL)
        AND (t.visibility = 'public' OR (t.visibility = 'unlisted' AND rb.target_uri IS NOT NULL))
      ORDER BY ${isoSql('COALESCE(t.published, t.created_at)')} DESC, t.rowid DESC
      LIMIT ? OFFSET ?`);
    return _cirkelPosts.all(slug, limit || 60, offset || 0);
  } catch { return []; }
}
/**
 * De rijen van voor shaer-7jkp hebben geen zichtbaarheid. Barts keuze: één keer
 * nakijken in plaats van ze voorgoed te verbergen. Ondertekend als de site
 * opgehaald, en dan beslist de ADRESSERING, niet of het ophalen lukte: een
 * server met authorized fetch weigert een ongetekend verzoek ook voor een
 * openbare post, en als volger krijgen we de vriendenpost juist wel -- met
 * zijn adressering erbij.
 *
 *   gelukt         → wat noteVisibility zegt;
 *   4xx (weg, geweigerd) → 'onbekend': blijft van de Cirkel af;
 *   storing / 5xx  → blijft NULL, de volgende keer opnieuw.
 *
 * Alleen kandidaten voor de Cirkel, hooguit `max` per ronde, `tegelijk` per
 * keer. deps = { get(slug, url, onStatus), zicht(object) }.
 */
export async function herkeurCirkel(slug, deps, { max = 200, tegelijk = 4 } = {}) {
  let rijen = [];
  try {
    rijen = db.prepare(`
      SELECT t.id FROM ap_timeline t
      LEFT JOIN ap_following f ON f.slug = t.slug AND f.actor_uri = t.author_uri
      LEFT JOIN ap_my_reactions rb ON rb.site_slug = t.slug AND rb.target_uri = t.id AND rb.kind = 'boost'
      WHERE t.slug = ? AND t.visibility IS NULL AND (f.auto_boost = 1 OR rb.target_uri IS NOT NULL)
      LIMIT ?`).all(slug, max);
  } catch { return { bekeken: 0 }; }
  const zet = db.prepare('UPDATE ap_timeline SET visibility = ? WHERE slug = ? AND id = ? AND visibility IS NULL');
  let i = 0, bekeken = 0;
  const werker = async () => {
    while (i < rijen.length) {
      const { id } = rijen[i++];
      let status = 0;
      const o = await Promise.resolve(deps.get(slug, id, (st) => { status = st; })).catch(() => null);
      const obj = o && o.type === 'Create' && o.object && typeof o.object === 'object' ? o.object : o;
      let v = null;
      if (obj && obj.id) v = deps.zicht(obj);
      else if (status >= 400 && status < 500) v = 'onbekend';
      if (v) { try { zet.run(v, slug, id); bekeken++; } catch { /* volgende keer */ } }
    }
  };
  await Promise.all(Array.from({ length: Math.min(tegelijk, rijen.length) }, werker));
  return { bekeken, open: rijen.length - bekeken };
}

export function getCirkelMembers(slug) {
  try { if (!_cirkelMembers) _cirkelMembers = db.prepare('SELECT name, url, icon FROM ap_following WHERE slug = ? AND auto_boost = 1 ORDER BY name'); return _cirkelMembers.all(slug); } catch { return []; }
}
