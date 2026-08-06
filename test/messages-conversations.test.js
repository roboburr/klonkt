// Berichten als gesprekken: antwoorden, mentions en je eigen verzonden
// berichten vouwen samen tot draden, de rest van de stroom blijft ongemoeid.
// Dit dekt de groepeerlogica zelf (zuiver, geen DB, geen netwerk); het
// samenstellen van de stroom zit in getMessages en leunt op de database.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

const { threadKey, groupConversations } = AP;

// Aflopend gesorteerd, zoals getMessages ze aanlevert.
const ts = (n) => new Date(Date.UTC(2026, 0, 1, 12, n)).toISOString();

test('threadKey: een post wint van een persoon', () => {
  assert.equal(threadKey({ type: 'reply', post_slug: 'hallo', handle: '@anna@a.test' }), 'post:hallo');
  assert.equal(threadKey({ type: 'sent', post_slug: 'hallo', to_handle: '@anna@a.test' }), 'post:hallo');
  // Zonder post loopt de draad per tegenpartij, hoofdletter- en @-ongevoelig.
  assert.equal(threadKey({ type: 'mention', handle: '@Anna@A.test' }), 'actor:anna@a.test');
  assert.equal(threadKey({ type: 'sent', to_handle: 'Anna@a.test' }), 'actor:anna@a.test');
});

test('threadKey: alles wat geen gesprek is krijgt geen draad', () => {
  for (const type of ['like', 'announce', 'follow', 'report', 'poll_done']) {
    assert.equal(threadKey({ type, post_slug: 'hallo' }), null, `${type} hoort geen draad te krijgen`);
  }
  assert.equal(threadKey(null), null);
  assert.equal(threadKey({ type: 'mention' }), null, 'een mention zonder afzender heeft geen sleutel');
});

test('ontvangen en verzonden op dezelfde post komen in EEN draad', () => {
  const out = groupConversations([
    { type: 'sent', post_slug: 'hallo', content: 'graag gedaan', created_at: ts(3) },
    { type: 'reply', post_slug: 'hallo', post_title: 'Hallo fediverse', handle: '@anna@a.test', name: 'Anna', content: 'dank!', created_at: ts(2) },
    { type: 'reply', post_slug: 'hallo', post_title: 'Hallo fediverse', handle: '@bo@b.test', name: 'Bo', content: 'mooi', created_at: ts(1) },
  ]);
  assert.equal(out.length, 1, 'drie berichten, één draad');
  const t = out[0];
  assert.equal(t.type, 'thread');
  assert.equal(t.count, 3);
  // De context hoort bij de draad: dit gesprek gaat over een post.
  assert.deepEqual(t.post, { slug: 'hallo', title: 'Hallo fediverse' });
  // Een gesprek leest naar beneden: oud → nieuw.
  assert.deepEqual(t.messages.map((m) => m.content), ['mooi', 'dank!', 'graag gedaan']);
  // De draad staat op de tijd van zijn NIEUWSTE bericht, zodat een levend
  // gesprek bovenaan komt.
  assert.equal(t.created_at, ts(3));
  // Jij zit er niet bij als deelnemer, de anderen wel.
  assert.deepEqual(t.people.map((p) => p.name), ['Bo', 'Anna']);
  assert.equal(t.mine, true);
});

test('een mention zonder post loopt per persoon, niet per post', () => {
  const out = groupConversations([
    { type: 'sent', to_handle: '@cas@c.test', content: 'hoi terug', created_at: ts(2) },
    { type: 'mention', handle: '@cas@c.test', name: 'Cas', content: 'hoi!', created_at: ts(1) },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'actor:cas@c.test');
  assert.equal(out[0].post, null, 'zonder post is er geen context-link');
  assert.deepEqual(out[0].messages.map((m) => m.content), ['hoi!', 'hoi terug']);
});

test('twee posts blijven twee draden, op volgorde van hun nieuwste bericht', () => {
  const out = groupConversations([
    { type: 'reply', post_slug: 'twee', post_title: 'Twee', handle: '@anna@a.test', created_at: ts(4) },
    { type: 'reply', post_slug: 'een', post_title: 'Een', handle: '@bo@b.test', created_at: ts(3) },
    { type: 'reply', post_slug: 'twee', post_title: 'Twee', handle: '@bo@b.test', created_at: ts(2) },
  ]);
  assert.deepEqual(out.map((t) => t.key), ['post:twee', 'post:een']);
  assert.equal(out[0].count, 2);
  assert.equal(out[1].count, 1);
});

test('likes, boosts en follows stromen ongemoeid tussen de draden door', () => {
  const out = groupConversations([
    { type: 'like', post_slug: 'hallo', handle: '@anna@a.test', created_at: ts(4) },
    { type: 'reply', post_slug: 'hallo', post_title: 'Hallo', handle: '@bo@b.test', created_at: ts(3) },
    { type: 'follow', handle: '@cas@c.test', created_at: ts(2) },
    { type: 'report', handle: '@dee@d.test', created_at: ts(1) },
  ]);
  assert.deepEqual(out.map((i) => i.type), ['like', 'thread', 'follow', 'report']);
  // Een like op dezelfde post trekt die post NIET de draad in: het is geen
  // gesprek, en Activiteit blijft zijn eigen chip houden.
  assert.equal(out[0].post_slug, 'hallo');
});

test('de titel komt van welk bericht in de draad hem ook maar kent', () => {
  // Een verzonden antwoord kent alleen de slug; een ontvangen antwoord de titel.
  const out = groupConversations([
    { type: 'sent', post_slug: 'hallo', created_at: ts(2) },
    { type: 'reply', post_slug: 'hallo', post_title: 'Hallo fediverse', handle: '@anna@a.test', created_at: ts(1) },
  ]);
  assert.deepEqual(out[0].post, { slug: 'hallo', title: 'Hallo fediverse' });
});

test('lege en rommelige invoer levert geen kapotte draden op', () => {
  assert.deepEqual(groupConversations([]), []);
  assert.deepEqual(groupConversations(null), []);
  // Een gesprekssoort zonder sleutel blijft een losse regel in plaats van te
  // verdwijnen: nooit een bericht kwijtraken in de groepering.
  const out = groupConversations([{ type: 'sent', content: 'aan niemand', created_at: ts(1) }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'sent');
});

test('een direct bericht zonder to_handle valt terug op to_actors', () => {
  // Precies het geval waarin het het onlogischst is dat er geen draad ontstaat:
  // een gesprek dat JIJ begon. Zonder deze terugval bleef het een losse regel.
  const key = threadKey({
    type: 'sent',
    to_actors: JSON.stringify(['https://a.test/users/anna', 'https://b.test/users/bo']),
    created_at: ts(1),
  });
  assert.equal(key, 'actor:anna@a.test');
  // Rommel in de kolom mag niets omgooien.
  assert.equal(threadKey({ type: 'sent', to_actors: 'geen json' }), null);
  assert.equal(threadKey({ type: 'sent', to_actors: '[]' }), null);
});

test('to_handle wint van to_actors, zodat een draad niet splitst', () => {
  const a = threadKey({ type: 'sent', to_handle: '@anna@a.test' });
  const b = threadKey({ type: 'sent', to_handle: '@anna@a.test', to_actors: JSON.stringify(['https://b.test/users/bo']) });
  assert.equal(a, b, 'dezelfde tegenpartij hoort dezelfde sleutel te geven');
});
