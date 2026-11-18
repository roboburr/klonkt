/**
 * Eenmalig: de #hashtags uit de tekst van bestaande posts ook als tags
 * bewaren (shaer-m5s6, Barts besluit van 18-11).
 *
 * Sinds die bead zet een post uit Shaer zijn hashtags in de tags-kolom, en de
 * tagpagina leest die kolom. Wat er al stond deed dat niet: eerdere posts uit
 * Shaer, en webposts met hashtags alleen in de tekst. Die stonden nooit onder
 * hun tag, terwijl hun hashtag er wel naartoe linkte.
 *
 * Bewust ook in het tagsveld van de editor: dat IS de tags-kolom. Wat er al
 * stond blijft staan en vooraan; alleen wat ontbrak komt erachter, zoals het
 * geschreven is. Ontdubbeld op tagKey, dus '#livemusic' in de tekst naast
 * 'Live Music' in het veld voegt niets toe. Niets federeert opnieuw en
 * updated_at blijft wat hij was: de post zelf verandert niet.
 */
import db from '../config/database.js';
import HtmlSanitizerService from './HtmlSanitizerService.js';
import { hashtagsIn, normalizeTags, tagKey } from './ap-core.js';

export const HASHTAG_TAGS_VERSION = 1;
const SLEUTEL = 'hashtag_tags_version';

/** De tags van één post na aanvulling, of null als er niets bij komt. */
export function aangevuld(tags, content) {
  const bestaand = normalizeTags(tags).map((t) => String(t)).filter((t) => tagKey(t));
  const gezien = new Set(bestaand.map(tagKey));
  const erbij = hashtagsIn(HtmlSanitizerService.toPlainText(content || '')).filter((t) => {
    const k = tagKey(t);
    if (!k || gezien.has(k)) return false;
    gezien.add(k);
    return true;
  });
  return erbij.length ? [...bestaand, ...erbij] : null;
}

export function migrateHashtagTags(opts = {}) {
  const uit = { aangevuld: 0, overgeslagen: false };
  try {
    if (!opts.force) {
      const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(SLEUTEL);
      if (r && (parseInt(r.value, 10) || 0) >= HASHTAG_TAGS_VERSION) { uit.overgeslagen = true; return uit; }
    }
  } catch { return uit; }   // geen app_settings: deze database is te oud om aan te raken
  try {
    const zet = db.prepare('UPDATE posts SET tags = ? WHERE id = ?');
    const rijen = db.prepare("SELECT id, tags, content FROM posts WHERE content LIKE '%#%'").all();
    db.transaction(() => {
      for (const p of rijen) {
        const nieuw = aangevuld(p.tags, p.content);
        if (nieuw) { zet.run(JSON.stringify(nieuw), p.id); uit.aangevuld++; }
      }
      db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(SLEUTEL, String(HASHTAG_TAGS_VERSION));
    })();
    if (uit.aangevuld) console.log(`🏷️  Hashtags als tags aangevuld op ${uit.aangevuld} post(s)`);
  } catch (e) {
    console.warn('[hashtag-backfill] mislukt:', e && e.message);
  }
  return uit;
}

export default { migrateHashtagTags, aangevuld, HASHTAG_TAGS_VERSION };
