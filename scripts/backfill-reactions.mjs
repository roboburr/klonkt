#!/usr/bin/env node
//
// Backfill: reacties uit de afgeleide kolommen naar de tussentabel (shaer-9e9).
//
// "Heb ik hierop gereageerd" stond in Klonkt op twee plekken die door
// verschillende routes werden gevuld: ap_timeline.liked/boosted (web-tijdlijn)
// en ap_my_reactions (interact-pagina). Sinds fase 1 schrijft setReaction ze
// allebei, maar alles van VOOR die wijziging staat nog maar in een van de twee.
//
// Dit script vult de tussentabel aan met wat alleen in de kolommen staat. Het
// moet draaien VOORDAT de lezers naar de tussentabel wijzen (fase 2), anders
// verdwijnen die reacties uit beeld -- stil, want een ontbrekende rij is geen
// fout.
//
//     node scripts/backfill-reactions.mjs --dry-run
//     node scripts/backfill-reactions.mjs
//
// Veilig om opnieuw te draaien: INSERT OR IGNORE plus de UNIQUE op
// (site_slug, target_uri, kind) maakt het idempotent.
//
// Wat het NIET kan: de oorspronkelijke reactiedatum herstellen. Wanneer je
// reageerde is nergens vastgelegd, dus de backfill-rijen krijgen de datum van
// nu. Dat is geen verlies dat te repareren valt, wel iets om te weten als je
// ooit op created_at gaat sorteren.

import db from '../src/config/database.js';

const dryRun = process.argv.includes('--dry-run');

const scheef = (kind, kolom) => db.prepare(`
  SELECT t.slug, t.id FROM ap_timeline t
   WHERE t.${kolom} = 1
     AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                      WHERE r.site_slug = t.slug AND r.target_uri = t.id AND r.kind = ?)
`).all(kind);

const voor = {
  tussentabel: db.prepare('SELECT COUNT(*) AS n FROM ap_my_reactions').get().n,
  liked: db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE liked = 1').get().n,
  boosted: db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE boosted = 1').get().n,
};
const teDoen = { like: scheef('like', 'liked'), boost: scheef('boost', 'boosted') };

console.log('vooraf :', JSON.stringify(voor));
console.log('aan te vullen: like =', teDoen.like.length, ', boost =', teDoen.boost.length);

if (dryRun) {
  for (const [kind, rijen] of Object.entries(teDoen)) {
    for (const r of rijen.slice(0, 10)) console.log(`  [dry-run] ${kind}  ${r.slug}  ${r.id}`);
    if (rijen.length > 10) console.log(`  ... en nog ${rijen.length - 10}`);
  }
  console.log('\n--dry-run: niets geschreven.');
  process.exit(0);
}

const ins = db.prepare('INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind) VALUES (?,?,?)');
let toegevoegd = 0;
db.transaction(() => {
  for (const [kind, rijen] of Object.entries(teDoen)) {
    for (const r of rijen) toegevoegd += ins.run(r.slug, r.id, kind).changes;
  }
})();

const na = {
  tussentabel: db.prepare('SELECT COUNT(*) AS n FROM ap_my_reactions').get().n,
  scheef: db.prepare(`
    SELECT COUNT(*) AS n FROM ap_timeline t
     WHERE (t.liked = 1 OR t.boosted = 1)
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = t.slug AND r.target_uri = t.id)`).get().n,
};

console.log('toegevoegd:', toegevoegd);
console.log('achteraf  :', JSON.stringify(na));

// De controle die telt: is er nog een vlag zonder tegenhanger? Zo ja, dan is de
// tussentabel nog niet veilig als bron en mag fase 2 niet.
if (na.scheef !== 0) {
  console.error(`\nLET OP: nog ${na.scheef} rij(en) met een vlag zonder tegenhanger. Fase 2 mag NIET.`);
  process.exit(1);
}
if (toegevoegd !== teDoen.like.length + teDoen.boost.length) {
  console.error('\nLET OP: het aantal toegevoegde rijen wijkt af van de meting vooraf.');
  process.exit(1);
}
console.log('\nOK: elke vlag heeft nu een tegenhanger in de tussentabel.');
