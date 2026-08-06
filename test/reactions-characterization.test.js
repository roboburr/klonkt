// KARAKTERISERING van "heb ik hierop gereageerd", vóór de opschoning van
// shaer-9e9. Deze tests beschrijven wat de code NU doet, niet wat ze zou moeten
// doen. Ze staan hier om de aanstaande refactor hoorbaar te maken.
//
// Waarom dat nodig is: dit gebied faalt stil. Elke mark*-aanroep zit in een
// try/catch die niets doet, en een UPDATE die geen rij raakt is geen fout. Zo
// kon de shaer:liked-bug (Klonkt 04aca12) maanden bestaan. Een refactor kan hier
// dus slagen, groen testen en tóch state kwijtraken -- tenzij het huidige gedrag
// eerst is vastgeschreven.
//
// LET OP: de tests onder "de twee bronnen lopen uiteen" roepen de PRIMITIEVEN
// aan (markLiked, setMyReaction). Die blijven bewust gescheiden -- het
// samenvoegen zit in setReaction, dus in de aanroepers, niet in de primitieven.
// Deze tests blijven daarom groen na fase 1 en beschrijven dan nog steeds iets
// waars: wie markLiked los aanroept, raakt de tussentabel niet. Dat is precies
// waarom setReaction bestaat en waarom die primitieven op termijn intern moeten
// worden.
//
// De invariant die fase 1 wél bewaakt staat onderaan, bij setReaction.
//
// Wat hier NIET in kan: de routes zelf (die vragen HTTP + sessie) en het
// C2S-pad voor Like/Announce (dat doet netwerk; zie de kop van
// c2s-outbox.test.js). Dit dekt de servicelaag waar alle drie de ingangen op
// uitkomen.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Me', 'u1');

const uri = (n) => `https://r.test/ap/notes/${n}`;

/** Een post van iemand anders in JOUW tijdlijn-cache. */
function seedTimeline(id, author = 'https://r.test/users/anna') {
  db.prepare(`INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, content, created_at)
              VALUES (?,?,?,?,?,?)`).run(id, 'me', author, 'Anna', '<p>x</p>', '2026-08-06 09:00:00');
}

// ── Ingang 1: de tijdlijn-route (posts.js ~1279-1304) ────────────────────
// Schrijft de KOLOM en leest de kolom. De tussentabel blijft ongemoeid.

test('tijdlijn-route: markLiked zet de kolom en getTimelineReaction leest hem', () => {
  const u = uri('t1'); seedTimeline(u);
  assert.deepEqual(AP.getTimelineReaction('me', u), { liked: false, boosted: false });
  AP.markLiked('me', u);
  assert.deepEqual(AP.getTimelineReaction('me', u), { liked: true, boosted: false });
  AP.unmarkLiked('me', u);
  assert.equal(AP.getTimelineReaction('me', u).liked, false);
});

test('tijdlijn-route: markBoosted zet de kolom en de post verschijnt in de Cirkel', () => {
  const u = uri('t2'); seedTimeline(u);
  assert.equal(AP.boostedCount('me'), 0);
  AP.markBoosted('me', u);
  assert.equal(AP.getTimelineReaction('me', u).boosted, true);
  assert.equal(AP.boostedCount('me'), 1);
  // De Cirkel is wat een gebruiker ziet: geboost = zichtbaar daar.
  assert.ok(AP.getCirkelPosts('me', 60, 0).some((p) => p.id === u), 'geboost hoort in de Cirkel te staan');
  AP.unmarkBoosted('me', u);
  assert.equal(AP.getCirkelPosts('me', 60, 0).some((p) => p.id === u), false);
});

test('tijdlijn-route: een vlag op een post die NIET in je tijdlijn staat gaat stil verloren', () => {
  // Dit is het stille falen waar de refactor voor moet oppassen: geen fout,
  // geen rij, geen spoor. Een UPDATE die niets raakt is voor SQLite in orde.
  const u = uri('bestaat-niet');
  AP.markLiked('me', u);
  assert.deepEqual(AP.getTimelineReaction('me', u), { liked: false, boosted: false });
});

// ── Ingang 2: de interact-route (posts.js ~841-869) ──────────────────────
// Schrijft de TUSSENTABEL en leest de tussentabel. De kolom blijft ongemoeid.

test('interact-route: setMyReaction schrijft de tussentabel, ook zonder tijdlijnrij', () => {
  const u = uri('i1');   // bewust NIET in ap_timeline
  assert.deepEqual(AP.getMyReactions('me', u), { liked: false, boosted: false });
  AP.setMyReaction('me', u, 'like', true);
  assert.deepEqual(AP.getMyReactions('me', u), { liked: true, boosted: false });
  AP.setMyReaction('me', u, 'boost', true);
  assert.deepEqual(AP.getMyReactions('me', u), { liked: true, boosted: true });
  AP.setMyReaction('me', u, 'like', false);
  assert.deepEqual(AP.getMyReactions('me', u), { liked: false, boosted: true });
});

test('interact-route: tweemaal dezelfde reactie levert geen dubbele rij op', () => {
  const u = uri('i2');
  AP.setMyReaction('me', u, 'like', true);
  AP.setMyReaction('me', u, 'like', true);
  const n = db.prepare('SELECT COUNT(*) AS n FROM ap_my_reactions WHERE site_slug=? AND target_uri=?').get('me', u).n;
  assert.equal(n, 1, 'de UNIQUE hoort het dubbel opslaan te voorkomen');
});

// ── De valkuil met naam: upsertBoostedNote is een INSERT ─────────────────

test('upsertBoostedNote trekt een post die je NIET volgt je tijdlijn in', () => {
  // Dit is geen vlag zetten. Zonder deze insert bestaat de rij niet, kan de
  // vlag nergens landen, en verschijnt de boost nergens. Wie dit in de refactor
  // vervangt door "gewoon markBoosted" boost iets wat daarna onvindbaar is.
  const u = uri('b1');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE id=?').get(u).n, 0);
  AP.upsertBoostedNote('me', {
    object_uri: u, actor_uri: 'https://r.test/users/bo', actor_name: 'Bo',
    content: '<p>geboost</p>', media: '[]',
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ap_timeline WHERE id=?').get(u).n, 1, 'de rij hoort aangemaakt te worden');
  assert.equal(AP.getTimelineReaction('me', u).boosted, true, 'en meteen als geboost gemarkeerd');
  assert.ok(AP.getCirkelPosts('me', 60, 0).some((p) => p.id === u), 'en dus zichtbaar in de Cirkel');
});

// ── De twee bronnen lopen uiteen ─────────────────────────────────────────
// De primitieven raken elkaar niet, en dat blijft na fase 1 zo: het
// samenvoegen zit in setReaction. Deze drie leggen vast waarom die functie
// moet bestaan, en waarom markLiked en broers uiteindelijk intern horen te
// worden -- zolang ze los aanroepbaar zijn, kan een aanroeper de helft doen.

test('HUIDIG GEDRAG: de tijdlijn-route vult de tussentabel niet', () => {
  const u = uri('d1'); seedTimeline(u);
  AP.markLiked('me', u);
  assert.equal(AP.getTimelineReaction('me', u).liked, true, 'de kolom staat aan');
  assert.equal(AP.getMyReactions('me', u).liked, false,
    'de primitief raakt de tussentabel niet -- daarvoor is setReaction');
});

test('HUIDIG GEDRAG: de interact-route vult de kolom niet', () => {
  const u = uri('d2'); seedTimeline(u);
  AP.setMyReaction('me', u, 'like', true);
  assert.equal(AP.getMyReactions('me', u).liked, true, 'de tussentabel staat aan');
  assert.equal(AP.getTimelineReaction('me', u).liked, false,
    'de primitief raakt de kolom niet -- daarvoor is setReaction');
});

test('HUIDIG GEDRAG: alleen het C2S-pad schrijft allebei', () => {
  // Wat ingestOutboxActivity sinds Klonkt 04aca12 doet, hier nagebootst zonder
  // het netwerk: setMyReaction + markLiked. Dit is het enige pad dat de twee
  // bronnen gelijk houdt, en precies daarom werkt un-liken vanuit een app wel.
  const u = uri('d3'); seedTimeline(u);
  AP.setMyReaction('me', u, 'like', true);
  AP.markLiked('me', u);
  assert.equal(AP.getMyReactions('me', u).liked, true);
  assert.equal(AP.getTimelineReaction('me', u).liked, true);
});

// ── De scheefheid, meetbaar (fase 0 uit shaer-9e9 als test) ─────────────

test('meetbaar: hoeveel rijen hebben een vlag zonder tegenhanger', () => {
  // Dezelfde query als fase 0 in shaer-9e9, hier als test zodat de refactor
  // hem kan gebruiken: na fase 1 hoort dit getal 0 te zijn en te blijven.
  const scheef = db.prepare(`
    SELECT COUNT(*) AS n FROM ap_timeline t
     WHERE (t.liked = 1 OR t.boosted = 1)
       AND NOT EXISTS (SELECT 1 FROM ap_my_reactions r
                        WHERE r.site_slug = t.slug AND r.target_uri = t.id)`).get().n;
  assert.ok(scheef > 0, 'vandaag lopen ze uiteen; na fase 1 hoort deze assert omgedraaid te worden naar === 0');
});

// ── De invariant van fase 1: setReaction houdt de bronnen gelijk ─────────

test('setReaction: een like landt in BEIDE bronnen', () => {
  const u = uri('sr1'); seedTimeline(u);
  AP.setReaction('me', u, 'like', true);
  assert.equal(AP.getMyReactions('me', u).liked, true, 'tussentabel');
  assert.equal(AP.getTimelineReaction('me', u).liked, true, 'afgeleide vlag');
  AP.setReaction('me', u, 'like', false);
  assert.equal(AP.getMyReactions('me', u).liked, false);
  assert.equal(AP.getTimelineReaction('me', u).liked, false);
});

test('setReaction: een boost met note trekt de post je tijdlijn in EN vult beide', () => {
  // De valkuil uit het plan: zonder de note bestaat de rij niet en landt de
  // vlag nergens, dus zou de boost onvindbaar zijn.
  const u = uri('sr2');
  AP.setReaction('me', u, 'boost', true, {
    note: { object_uri: u, actor_uri: 'https://r.test/users/bo', actor_name: 'Bo', content: '<p>x</p>', media: '[]' },
  });
  assert.equal(AP.getMyReactions('me', u).boosted, true, 'tussentabel');
  assert.equal(AP.getTimelineReaction('me', u).boosted, true, 'afgeleide vlag');
  assert.ok(AP.getCirkelPosts('me', 60, 0).some((p) => p.id === u), 'en zichtbaar in de Cirkel');
  AP.setReaction('me', u, 'boost', false);
  assert.equal(AP.getMyReactions('me', u).boosted, false);
  assert.equal(AP.getCirkelPosts('me', 60, 0).some((p) => p.id === u), false);
});

test('setReaction: flagUri bepaalt de sleutel voor BEIDE bronnen', () => {
  // Vroeger kreeg de tussentabel de URI die de client stuurde en de vlag de
  // opgeloste. Nu is het er één, anders is dezelfde like onvindbaar vanaf een
  // pagina die de andere URI kent.
  const gestuurd = 'https://r.test/@anna/123';
  const opgelost = uri('sr3');
  seedTimeline(opgelost);
  AP.setReaction('me', gestuurd, 'like', true, { flagUri: opgelost });
  assert.equal(AP.getReaction('me', opgelost).liked, true, 'onder de opgeloste uri');
  assert.equal(AP.getTimelineReaction('me', opgelost).liked, true, 'en de vlag ook');
  assert.equal(AP.getMyReactions('me', gestuurd).liked, false, 'niet meer onder de gestuurde');
});

test('setReaction: rommelige invoer doet niets in plaats van iets halfs', () => {
  AP.setReaction('me', uri('sr4'), 'sterretje', true);
  assert.equal(AP.getMyReactions('me', uri('sr4')).liked, false);
  AP.setReaction('', uri('sr5'), 'like', true);
  AP.setReaction('me', '', 'like', true);
  assert.equal(AP.getMyReactions('me', uri('sr5')).liked, false);
});

// ── Fase 2: lezen komt uit de tussentabel ────────────────────────────────

test('getReaction leest de tussentabel, niet de kolom', () => {
  const u = uri('g1'); seedTimeline(u);
  AP.setReaction('me', u, 'like', true);
  assert.deepEqual(AP.getReaction('me', u), { liked: true, boosted: false });
  AP.setReaction('me', u, 'boost', true);
  assert.deepEqual(AP.getReaction('me', u), { liked: true, boosted: true });
});

test('WAAROM DE BACKFILL EERST MOET: een kale kolomvlag is onzichtbaar voor getReaction', () => {
  // Dit is de reden dat scripts/backfill-reactions.mjs tussen fase 1 en 2 hoort.
  // Een reactie van vóór fase 1 staat alleen in de kolom; zodra de lezers de
  // tussentabel volgen is die stil verdwenen -- geen fout, geen spoor.
  const u = uri('g2'); seedTimeline(u);
  AP.markLiked('me', u);                                  // zoals de oude tijdlijn-route
  assert.equal(AP.getTimelineReaction('me', u).liked, true, 'de kolom staat aan');
  assert.equal(AP.getReaction('me', u).liked, false, 'maar het nieuwe leespad ziet hem niet');
  // Wat de backfill doet:
  AP.setMyReaction('me', u, 'like', true);
  assert.equal(AP.getReaction('me', u).liked, true, 'na aanvullen wel');
});

test('getReactionsFor haalt een hele pagina in één keer op', () => {
  const a = uri('g3'), b = uri('g4'), c = uri('g5');
  seedTimeline(a); seedTimeline(b);
  AP.setReaction('me', a, 'like', true);
  AP.setReaction('me', b, 'boost', true);
  const m = AP.getReactionsFor('me', [a, b, c]);
  assert.equal(m.get(a).liked, true);
  assert.equal(m.get(b).boosted, true);
  assert.equal(m.get(c), undefined, 'wie niets heeft komt niet in de map; de aanroeper valt terug op false');
  // Dezelfde uitkomst als per stuk vragen, zodat de batch geen eigen waarheid wordt.
  for (const u of [a, b]) assert.deepEqual(m.get(u), AP.getReaction('me', u));
});

test('getReactionsFor: lege of rommelige invoer geeft een lege map', () => {
  assert.equal(AP.getReactionsFor('me', []).size, 0);
  assert.equal(AP.getReactionsFor('me', null).size, 0);
  assert.equal(AP.getReactionsFor('', [uri('g3')]).size, 0);
});

// ── Fase 3: het publieke oppervlak is versmald ───────────────────────────

test('de primitieven zijn niet meer bereikbaar via het service-object', async () => {
  // Routes doen `import ActivityPubService from ...` en werken dus met het
  // default-object. Zolang markLiked daar in staat, kan een aanroeper de helft
  // schrijven -- en dat is niet hypothetisch: precies zo bleef shaer:liked
  // maandenlang false. De named exports blijven bestaan voor intern gebruik en
  // voor deze tests.
  const svc = (await import('../src/services/ActivityPubService.js')).default;
  for (const naam of ['markLiked', 'unmarkLiked', 'markBoosted', 'unmarkBoosted',
                      'setMyReaction', 'getMyReactions', 'getTimelineReaction']) {
    assert.equal(svc[naam], undefined, `${naam} hoort niet op het publieke oppervlak te staan`);
  }
  // Wat er WEL hoort te staan: het ene schrijfpad en het ene leespad.
  for (const naam of ['setReaction', 'getReaction', 'getReactionsFor']) {
    assert.equal(typeof svc[naam], 'function', `${naam} hoort er wel te zijn`);
  }
});

// ── De permalink en de object-URI zijn dezelfde post ─────────────────────

test('een like uit de Krant is zichtbaar op de interact-pagina (Robins melding)', () => {
  // De Krant kent een post als AP-object-URI, de interact-pagina als permalink.
  // Zochten die twee in verschillende sleutelruimtes, dan toonde een geboost en
  // geliket bericht daar geen enkele highlight -- terwijl de reactie bestond.
  const obj = uri('perm1');
  const permalink = 'https://sound-fabrics.com/effortlesseffect';
  db.prepare(`INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, content, url, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(obj, 'me', 'https://r.test/users/anna', 'Anna', '<p>x</p>', permalink, '2026-08-06 09:00:00');

  AP.setReaction('me', obj, 'like', true);      // zoals de Krant het doet
  AP.setReaction('me', obj, 'boost', true);
  // en de interact-pagina vraagt het met de permalink:
  assert.deepEqual(AP.getReaction('me', permalink), { liked: true, boosted: true });
});

test('andersom net zo: reageren via de permalink landt op de object-URI', () => {
  const obj = uri('perm2');
  const permalink = 'https://sound-fabrics.com/tweede';
  db.prepare(`INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, content, url, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(obj, 'me', 'https://r.test/users/bo', 'Bo', '<p>y</p>', permalink, '2026-08-06 09:00:00');

  AP.setReaction('me', permalink, 'like', true);   // zoals de interact-pagina het doet
  assert.equal(AP.getReaction('me', obj).liked, true, 'onder de object-uri opgeslagen');
  assert.equal(AP.getTimelineReaction('me', obj).liked, true, 'dus de vlag landt ook goed');
  assert.equal(AP.getReaction('me', permalink).liked, true, 'en blijft vindbaar via de permalink');
});

test('een reactie op iets buiten je tijdlijn blijft gewoon werken', () => {
  // Kennen we de post niet, dan is er niets te canoniseren en blijft de invoer
  // de sleutel. Een like op een vreemde post mag daar niet op stuklopen.
  const onbekend = 'https://elders.test/notes/xyz';
  AP.setReaction('me', onbekend, 'like', true);
  assert.equal(AP.getReaction('me', onbekend).liked, true);
});

// ── De migratie bij boot ─────────────────────────────────────────────────

test('migrateReactions hersleutelt een permalink-rij naar de object-URI', () => {
  // De oude interact-route bewaarde de URI waarmee je binnenkwam, en de
  // bookmarklet geeft de permalink door. Zonder hersleutelen zijn die rijen
  // wees zodra er op de object-URI gezocht wordt.
  const obj = uri('mig1');
  const permalink = 'https://sound-fabrics.com/oud-artikel';
  db.prepare(`INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, content, url, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(obj, 'me', 'https://r.test/users/anna', 'Anna', '<p>x</p>', permalink, '2026-08-06 09:00:00');
  db.prepare("INSERT OR IGNORE INTO ap_my_reactions (site_slug, target_uri, kind, created_at) VALUES (?,?,?,?)")
    .run('me', permalink, 'like', '2026-07-01 12:00:00');

  const uitkomst = AP.migrateReactions({ force: true });
  assert.ok(uitkomst.hersleuteld >= 1);
  assert.equal(AP.getReaction('me', obj).liked, true, 'nu vindbaar op de object-uri');
  const rij = db.prepare('SELECT created_at FROM ap_my_reactions WHERE site_slug=? AND target_uri=? AND kind=?').get('me', obj, 'like');
  assert.equal(rij.created_at, '2026-07-01 12:00:00', 'bij hersleutelen blijft de oorspronkelijke datum staan');
  const oud = db.prepare('SELECT COUNT(*) AS n FROM ap_my_reactions WHERE target_uri=?').get(permalink).n;
  assert.equal(oud, 0, 'de permalink-rij is opgeruimd');
});

test('migrateReactions vult een kale kolomvlag aan', () => {
  const u = uri('mig2'); seedTimeline(u);
  AP.markLiked('me', u);                                  // zoals de oude Krant-route
  assert.equal(AP.getReaction('me', u).liked, false, 'vooraf onzichtbaar');
  AP.migrateReactions({ force: true });
  assert.equal(AP.getReaction('me', u).liked, true, 'daarna zichtbaar');
});

test('migrateReactions is idempotent en respecteert de versievlag', () => {
  const eerste = AP.migrateReactions({ force: true });
  const tweede = AP.migrateReactions({ force: true });
  assert.equal(tweede.hersleuteld, 0, 'niets meer te hersleutelen');
  assert.equal(tweede.aangevuld, 0, 'niets meer aan te vullen');
  assert.ok(eerste.hersleuteld >= 0);
  // Zonder force draait hij niet nog eens zodra de vlag staat.
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)').run('reactions_migration_version', '1');
  assert.equal(AP.migrateReactions().overgeslagen, true);
});

test('migrateReactions --dry-run schrijft niets', () => {
  const u = uri('mig3'); seedTimeline(u);
  AP.markLiked('me', u);
  const telling = AP.migrateReactions({ force: true, dryRun: true });
  assert.ok(telling.aangevuld >= 1, 'hij ziet wel wat er te doen is');
  assert.equal(AP.getReaction('me', u).liked, false, 'maar heeft niets geschreven');
});
