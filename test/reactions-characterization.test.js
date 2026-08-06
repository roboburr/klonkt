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

test('setReaction: gescheiden sleutels blijven werken zolang ze bestaan', () => {
  // De tussentabel wordt gesleuteld op wat de client stuurde, de vlag op de
  // opgeloste object-URI. Meestal gelijk, niet gegarandeerd. flagUri houdt dat
  // uit elkaar tot fase 2 ze samentrekt.
  const gestuurd = 'https://r.test/@anna/123';
  const opgelost = uri('sr3');
  seedTimeline(opgelost);
  AP.setReaction('me', gestuurd, 'like', true, { flagUri: opgelost });
  assert.equal(AP.getMyReactions('me', gestuurd).liked, true, 'op de gestuurde uri');
  assert.equal(AP.getTimelineReaction('me', opgelost).liked, true, 'op de opgeloste uri');
});

test('setReaction: rommelige invoer doet niets in plaats van iets halfs', () => {
  AP.setReaction('me', uri('sr4'), 'sterretje', true);
  assert.equal(AP.getMyReactions('me', uri('sr4')).liked, false);
  AP.setReaction('', uri('sr5'), 'like', true);
  AP.setReaction('me', '', 'like', true);
  assert.equal(AP.getMyReactions('me', uri('sr5')).liked, false);
});
