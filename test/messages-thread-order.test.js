// Binnen een gesprek leest Berichten van NIEUW naar OUD (Robins besluit,
// 25-8), en een ontvangen zwaai staat in de KOP van de draad -- want ingeklapt
// zijn de bubbels weg, en juist een zwaai vraagt om een antwoord.
//
// Dit rendert de echte partial. EJS-fouten bestaan alleen tijdens het renderen:
// een verkeerde variabelenaam of een scheve `<% %>` valt hier om en nergens
// anders in de suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const partial = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views', 'partials', 'msg-item.ejs');

// De helpers die de pagina normaal meegeeft. Ze geven hun invoer terug, zodat
// wat er in het antwoord staat uit de PARTIAL komt en niet uit een stub.
const helpers = { t: (k) => k, avatar: (u) => u, emojiName: (n) => n, formatDateTime: (d) => String(d), canMutate: false, seen: 0 };

// De naam is het herkenningspunt: de inhoud loopt via note-body, dat eigen
// velden leest. De kop draagt alleen `people`, dus deze drie namen kunnen
// alleen uit de bubbels zelf komen.
function draad(extra = {}) {
  return {
    type: 'thread', key: 'k1', post: null, count: 3, people: [{ name: 'Bart' }],
    created_at: '2026-08-25T10:00:00Z',
    messages: [
      { type: 'mention', name: 'OUDSTE', handle: '@a', created_at: '2026-08-25T09:00:00Z' },
      { type: 'mention', name: 'MIDDELSTE', handle: '@b', created_at: '2026-08-25T09:30:00Z' },
      { type: 'mention', name: 'NIEUWSTE', handle: '@c', wave: true, created_at: '2026-08-25T10:00:00Z' },
    ],
    ...extra,
  };
}

const render = (n) => ejs.renderFile(partial, { ...helpers, n });

test('binnen een gesprek staat het nieuwste bovenaan', async () => {
  const html = await render(draad());
  const nieuw = html.indexOf('NIEUWSTE'), midden = html.indexOf('MIDDELSTE'), oud = html.indexOf('OUDSTE');
  assert.ok(nieuw > -1 && midden > -1 && oud > -1, 'alle drie de berichten staan er');
  assert.ok(nieuw < midden && midden < oud, `nieuwste bovenaan, kreeg N=${nieuw} M=${midden} O=${oud}`);
});

test('de draad-array zelf blijft oplopend', async () => {
  // groupConversations sorteert oplopend en de rest van de pagina rekent
  // daarop: `_tnew` en `_tto` lezen dezelfde array. Draaide de partial het
  // origineel om, dan werkt dat door naar alles wat er daarna naar kijkt.
  const d = draad();
  await render(d);
  assert.deepEqual(d.messages.map((m) => m.name), ['OUDSTE', 'MIDDELSTE', 'NIEUWSTE']);
});

test('een ontvangen zwaai staat in de kop, voor de bubbels', async () => {
  const html = await render(draad());
  const kop = html.indexOf('msg-thread-wave');
  assert.ok(kop > -1, 'de kop draagt een zwaai-teken');
  assert.ok(kop < html.indexOf('msg-thread-msgs'), 'en staat in de kop, niet tussen de bubbels');
});

test('geen zwaai, geen teken', async () => {
  const stil = draad();
  stil.messages = stil.messages.map((m) => ({ ...m, wave: false }));
  assert.equal((await render(stil)).includes('msg-thread-wave'), false);
});

test('een zwaai die JIJ stuurde is geen uitnodiging aan jezelf', async () => {
  const eigen = draad({ messages: [{ type: 'sent', to_handle: '@bart@pruts.nl', wave: true, created_at: '2026-08-25T10:00:00Z' }] });
  assert.equal((await render(eigen)).includes('msg-thread-wave'), false);
});
