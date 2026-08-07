#!/usr/bin/env node
//
// Reactie-migratie handmatig draaien (shaer-9e9).
//
// Normaal hoef je dit NIET: migrateReactions() draait bij boot, één keer per
// REACTIONS_MIGRATION_VERSION-bump, net als de self-heal. Dit script is er om
// vooraf te kijken wat er zou gebeuren, of om het gericht op één instance te
// forceren.
//
//     node scripts/backfill-reactions.mjs --dry-run
//     node scripts/backfill-reactions.mjs            # respecteert de versievlag
//     node scripts/backfill-reactions.mjs --force    # ook als de vlag al staat
//
// Bewust een schil om dezelfde functie die bij boot draait: twee implementaties
// van een migratie lopen uiteen, en dan repareert de ene wat de andere niet ziet.
//
// Wat het doet, en waarom allebei nodig is:
//
//   HERSLEUTELEN  De oude interact-route bewaarde de URI waarmee je binnenkwam,
//                 en de bookmarklet geeft de permalink door. Sinds de reacties
//                 op de canonieke object-URI gezocht worden, zouden die rijen
//                 wees zijn. De created_at reist mee.
//   AANVULLEN     Alles wat op oude code via de Krant is gegeven staat alleen in
//                 ap_timeline.liked/boosted. Zonder deze stap toont het als
//                 niet-gereageerd -- en klikt iemand opnieuw, met een tweede
//                 Like de fediverse in als gevolg.
//   UIT REACTIES  De derde bron (shaer-ipb): ap_interactions.acted_like/_boost,
//                 wat jij deed met een reactie ONDER je eigen post. Zelfde
//                 gevolg als hierboven, alleen op een ander oppervlak.
//
// Wat het NIET kan: bij AANVULLEN de oorspronkelijke reactiedatum herstellen.
// Wanneer je reageerde is nergens vastgelegd, dus die rijen krijgen de datum van
// nu. Bij hersleutelen blijft de datum wel behouden.

import db from '../src/config/database.js';
import { migrateReactions } from '../src/services/ActivityPubService.js';

const dryRun = process.argv.includes('--dry-run');
const force = process.argv.includes('--force');

const meet = () => ({
  tussentabel: db.prepare('SELECT COUNT(*) AS n FROM ap_my_reactions').get().n,
  liked: db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE liked = 1').get().n,
  boosted: db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE boosted = 1').get().n,
  scheef: db.prepare(`
    SELECT COUNT(*) AS n FROM ap_timeline t
     WHERE (t.liked = 1 OR t.boosted = 1)
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = t.slug AND r.target_uri = t.id)`).get().n,
  // Een reactie op een COMMENT hoort geen tijdlijnrij te hebben, dus die telt
  // hier niet als wees -- anders slaat de controle hieronder alarm op precies
  // wat stap 3 net goed heeft gezet.
  wees: db.prepare(`
    SELECT COUNT(*) AS n FROM ap_my_reactions r
     WHERE NOT EXISTS (SELECT 1 FROM ap_timeline t
                        WHERE t.slug = r.site_slug AND t.id = r.target_uri)
       AND NOT EXISTS (SELECT 1 FROM ap_interactions i WHERE i.object_uri = r.target_uri)`).get().n,
  scheefActed: db.prepare(`
    SELECT COUNT(*) AS n FROM ap_interactions i
     JOIN posts p ON p.id = i.post_id
     JOIN sites s ON s.id = p.site_id
     WHERE (i.acted_like = 1 OR i.acted_boost = 1) AND IFNULL(i.object_uri, '') <> ''
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = s.slug AND r.target_uri = i.object_uri)`).get().n,
});

const voor = meet();
console.log('vooraf :', JSON.stringify(voor));

const uit = migrateReactions({ dryRun, force: force || dryRun });
if (uit.overgeslagen) {
  console.log('\novergeslagen: de versievlag staat al. Gebruik --force om toch te draaien.');
  process.exit(0);
}
if (dryRun) {
  console.log(`\n--dry-run: zou ${uit.hersleuteld} rij(en) hersleutelen, ${uit.aangevuld} aanvullen`
    + ` en ${uit.reacties} uit reacties overnemen. Niets geschreven.`);
  process.exit(0);
}

const na = meet();
console.log('hersleuteld:', uit.hersleuteld, ' aangevuld:', uit.aangevuld, ' uit reacties:', uit.reacties);
console.log('achteraf   :', JSON.stringify(na));

// De twee controles die tellen. Blijft er een vlag zonder tegenhanger, dan is de
// tussentabel niet compleet en tonen reacties als niet-gegeven. Blijft er een
// tussentabel-rij zonder tijdlijnrij, dan is die op iets buiten je tijdlijn
// gericht (legitiem) OF nog op een permalink (niet legitiem) -- vandaar de
// waarschuwing in plaats van een fout.
if (na.scheef !== 0) {
  console.error(`\nFOUT: nog ${na.scheef} rij(en) met een vlag zonder tegenhanger.`);
  process.exit(1);
}
if (na.scheefActed !== 0) {
  console.error(`\nFOUT: nog ${na.scheefActed} reactie(s) onder je eigen posts met acted_* zonder tegenhanger.`);
  process.exit(1);
}
if (na.wees > voor.wees) {
  console.error('\nFOUT: er zijn tussentabel-rijen bijgekomen die nergens op slaan.');
  process.exit(1);
}
if (na.wees) {
  console.warn(`\nLET OP: ${na.wees} tussentabel-rij(en) zonder tijdlijnrij. Dat mag (een reactie op iets\n`
    + 'buiten je tijdlijn), maar controleer of er geen permalinks tussen zitten van een post die je\n'
    + 'wel kent -- die zouden hersleuteld moeten zijn.');
}
console.log('\nOK: elke vlag heeft een tegenhanger in de tussentabel.');
