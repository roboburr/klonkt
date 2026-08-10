// Standaardvormen in plaats van eigen dialect (shaer-nmw).
//
// Robins waarschuwing: geen Klonkt/Shaer-dialect schrijven waar AS2 of een FEP
// het al regelt. Deze toetsen zijn het criterium uit die bead -- niet "onze app
// snapt het", maar: HEEFT EEN GENERIEKE AP-LEZER ER IETS AAN. Daarom kijken ze
// alleen naar standaardvelden en nooit naar een shaer:-property.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

test('attributedTo draagt de actor als object, zodat elke client een byline heeft', () => {
  const uit = AP.actorObject('https://elders/u/tante', {
    name: 'Tante Til', handle: '@til@elders', icon: 'https://elders/til.png',
    url: 'https://elders/@til', emojis: { ':zwaai:': 'https://elders/zwaai.png' },
  });
  assert.equal(uit.id, 'https://elders/u/tante');
  assert.equal(uit.type, 'Person');
  assert.equal(uit.name, 'Tante Til');
  // De LOKALE naam, zoals AS2 hem bedoelt; de handle leidt een lezer af uit
  // preferredUsername plus de host van de id.
  assert.equal(uit.preferredUsername, 'til');
  assert.deepEqual(uit.icon, { type: 'Image', url: 'https://elders/til.png' });
  // FEP-9098 hoort in tag, niet in een eigen emoji-kaart.
  assert.equal(uit.tag[0].type, 'Emoji');
  assert.equal(uit.tag[0].name, ':zwaai:');
});

test('weten we niets van de persoon, dan blijft attributedTo de kale URI', () => {
  // Een leeg object zou beweren dat we hem kennen. Een URI is eerlijk en is
  // bovendien wat elke AP-server verwacht.
  assert.equal(AP.actorObject('https://elders/u/onbekend', undefined), 'https://elders/u/onbekend');
  assert.equal(AP.actorObject('https://elders/u/onbekend', {}), 'https://elders/u/onbekend');
});

test('een linkkaart is een AS2 preview met url, name en image', () => {
  const embed = JSON.stringify({
    url: 'https://nieuws.example/artikel', title: 'Een mooi artikel',
    author: { name: 'De Krant' }, media: [{ url: 'https://nieuws.example/p.jpg' }],
  });
  const p = AP.previewObject(embed, { playback: false });
  assert.equal(p.type, 'Page');
  assert.equal(p.url, 'https://nieuws.example/artikel');
  assert.equal(p.name, 'Een mooi artikel');
  assert.deepEqual(p.image, { type: 'Image', url: 'https://nieuws.example/p.jpg' });
  assert.equal(p.attributedTo.name, 'De Krant');
  // De spelerpagina blijft van ons: die hangt aan de guardian-poort en heeft
  // geen AS2-tegenhanger. Dicht = niet aanwezig.
  assert.ok(!p['shaer:playerUrl']);
});

test('een quote is de geciteerde Note zelf (FEP-044f), met ingesloten auteur', () => {
  const snapshot = JSON.stringify({
    url: 'https://elders/notes/1',
    author: { name: 'Til', handle: '@til@elders', icon: 'https://elders/til.png' },
    content: '<p>hallo</p>', published: '2026-08-01T10:00:00Z',
    media: [{ url: 'https://elders/foto.jpg', type: 'image/jpeg' }],
  });
  const q = AP.quoteObject(snapshot);
  assert.equal(q.type, 'Note');
  assert.equal(q.id, 'https://elders/notes/1');
  assert.equal(q.content, '<p>hallo</p>');
  assert.equal(q.published, '2026-08-01T10:00:00Z');
  // De auteur van het citaat is zelf ook een ingesloten actor, niet een
  // losse naam-kaart.
  assert.equal(q.attributedTo.type, 'Person');
  assert.equal(q.attributedTo.name, 'Til');
  assert.equal(q.attributedTo.preferredUsername, 'til');
  assert.deepEqual(q.attachment, [{ type: 'Document', mediaType: 'image/jpeg', url: 'https://elders/foto.jpg' }]);
});

test('niets te tonen levert niets op, geen leeg omhulsel', () => {
  assert.equal(AP.previewObject(null), undefined);
  assert.equal(AP.previewObject('{}'), undefined);
  assert.equal(AP.quoteObject(null), undefined);
  assert.equal(AP.quoteObject('rommel'), undefined);
});
