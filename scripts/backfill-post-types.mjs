#!/usr/bin/env node
/**
 * Zet bestaande type=audio posts om naar album of playlist. (shaer-cyg)
 *
 * Audio is geen keuze meer: alles wat muziek is landt op album of playlist. Wat
 * er al staat moet daar dus heen, en dat is een migratie en geen hernoeming --
 * welke van de twee het wordt hangt af van wat er IN de post zit. Die afleiding
 * staat in music/postMusicType en wordt hier alleen toegepast.
 *
 *   node scripts/backfill-post-types.mjs            # laat zien wat er zou gebeuren
 *   node scripts/backfill-post-types.mjs --doen     # en voert het uit
 *
 * Idempotent: kijkt alleen naar type='audio', dus een tweede run doet niets.
 * Posts waar de afleiding geen album of playlist van maakt (twee collecties,
 * een onvindbare playlist, of helemaal geen muziek meer) blijven met rust
 * gelaten en worden apart gemeld -- die verdienen een blik en geen gok.
 */
import db from '../src/config/database.js';
import { postMusicType } from '../src/services/music/index.js';

const DOEN = process.argv.includes('--doen');

const posts = db.prepare(`
  SELECT p.id, p.site_id, p.slug, p.title, p.content, s.slug AS site_slug
  FROM posts p JOIN sites s ON s.id = p.site_id
  WHERE p.type = 'audio'
  ORDER BY p.created_at
`).all();

console.log(`[backfill-post-types] ${posts.length} post(s) met type=audio${DOEN ? '' : '  (proefdraai — geef --doen om te schrijven)'}`);

const update = db.prepare('UPDATE posts SET type = ? WHERE id = ?');
const telling = { album: 0, playlist: 0 };
const overgeslagen = [];

for (const p of posts) {
  const r = postMusicType(p.content, p.site_id);
  const naam = `${p.site_slug}/${p.slug}`;

  if (!r || (r.type !== 'album' && r.type !== 'playlist')) {
    const reden = !r ? 'geen muziek meer in de post'
      : r.onbekend?.length ? `playlist niet gevonden: ${r.onbekend.join(', ')}`
      : `${r.collecties?.length ?? 0} collecties — de post blijft een post`;
    overgeslagen.push({ naam, reden });
    continue;
  }

  telling[r.type]++;
  const bonus = r.bonus?.length ? `, ${r.bonus.length} bonus-track(s)` : '';
  console.log(`  ${r.type.padEnd(8)} ${naam}${bonus}`);
  if (DOEN) update.run(r.type, p.id);
}

console.log(`\n  album:    ${telling.album}`);
console.log(`  playlist: ${telling.playlist}`);

if (overgeslagen.length) {
  console.log(`\n  overgeslagen (${overgeslagen.length}) — deze blijven type=audio:`);
  for (const o of overgeslagen) console.log(`    ${o.naam}: ${o.reden}`);
}

if (!DOEN && (telling.album || telling.playlist)) {
  console.log('\nNiets geschreven. Draai opnieuw met --doen als dit klopt.');
}
