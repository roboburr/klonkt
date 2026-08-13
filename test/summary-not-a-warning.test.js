// Een samenvatting is geen waarschuwing (Barts melding, 13-8).
//
// Posts van europeanpirates.eu (WordPress + ActivityPub) kwamen in Shaer binnen
// achter een content warning, terwijl `sensitive` niet gezet is. De tekst van
// die "waarschuwing" was de eerste alinea van de post zelf, afgekapt -- de
// excerpt die WordPress voor Mastodon meestuurt.
//
// In AS2 IS summary een samenvatting: "a natural language summarization of the
// object". Mastodon hergebruikt dat veld als waarschuwing en zet er sensitive
// bij. Zonder sensitive is het dus gewoon een samenvatting, en die als
// waarschuwing tonen verbergt de post achter zijn eigen tekst.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

// De vorm zoals europeanpirates.eu hem stuurt, ingekort.
const ARTIKEL = {
  id: 'https://europeanpirates.eu/?p=5978',
  type: 'Article',
  name: 'The Ad Blocker You Chose is Being Removed for You',
  summary: 'On 31 August 2026, the Chrome Web Store removes the last extensions built on Manifest V2, the older rulebook that...',
  content: '<p>On 31 August 2026, the Chrome Web Store <a href="https://example.test">removes</a> the last extensions.</p>',
  url: 'https://europeanpirates.eu/the-ad-blocker-you-chose-is-being-removed-for-you/',
};

test('zonder sensitive is een summary geen waarschuwing', () => {
  assert.equal(AP.contentWarning(ARTIKEL), null);
});

test('met sensitive is hij dat wel, en dan is de tekst de waarschuwing', () => {
  assert.equal(
    AP.contentWarning({ ...ARTIKEL, sensitive: true }),
    ARTIKEL.summary,
  );
});

test('sensitive zonder tekst blijft leeg -- de vlag doet het werk', () => {
  // Mastodon staat toe dat je alleen de media als gevoelig markeert. Dan is er
  // niets te lezen en versluiert de vlag; een lege waarschuwing verzinnen zou
  // een label zonder inhoud opleveren.
  assert.equal(AP.contentWarning({ sensitive: true }), null);
  assert.equal(AP.contentWarning({ sensitive: true, summary: '   ' }), null);
});

test('de titel van een artikel gaat niet verloren', () => {
  // Zonder dit kwam een WordPress-post binnen als kale body: de titel zit in
  // `name` en die gooiden we weg, terwijl de excerpt ten onrechte als
  // waarschuwing dienstdeed. Allebei fout, en allebei zichtbaar in een post
  // die er onherkenbaar uitzag.
  const uit = AP.timelineFields(ARTIKEL);
  assert.ok(uit.html.includes('The Ad Blocker You Chose is Being Removed for You'),
    'de kop staat erin');
  assert.ok(uit.html.includes('removes'), 'en de body ook');
});

test('een gewone Note verandert niet', () => {
  const note = { id: 'x', type: 'Note', content: '<p>hoi</p>' };
  assert.equal(AP.timelineFields(note).html, '<p>hoi</p>');
  assert.equal(AP.contentWarning(note), null);
});
