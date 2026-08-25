// Twee beslissingen over Berichten (Robins besluit, 25-8), en niet meer dan
// dat: binnen een gesprek leest het van NIEUW naar OUD, en een ONTVANGEN zwaai
// zet een markering op de draad. Waar de dingen op de pagina STAAN wordt hier
// met opzet niet getoetst -- dat is layout, en een toets daarop breekt bij de
// eerstvolgende verschuiving zonder dat er iets stuk is.
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

test('binnen een gesprek leest het van nieuw naar oud, zonder de bron te draaien', async () => {
  const d = draad();
  const html = await render(d);
  const nieuw = html.indexOf('NIEUWSTE'), midden = html.indexOf('MIDDELSTE'), oud = html.indexOf('OUDSTE');
  assert.ok(nieuw > -1 && midden > -1 && oud > -1, 'alle drie de berichten staan er');
  assert.ok(nieuw < midden && midden < oud, `nieuwste eerst, kreeg N=${nieuw} M=${midden} O=${oud}`);
  // En de DOORGEGEVEN array blijft oplopend: groupConversations sorteert zo en
  // de rest van de pagina rekent daarop (`_tnew` en `_tto` lezen dezelfde
  // array). Draaide de partial het origineel om, dan werkt dat door naar alles
  // wat er daarna naar kijkt.
  assert.deepEqual(d.messages.map((m) => m.name), ['OUDSTE', 'MIDDELSTE', 'NIEUWSTE']);
});

test('de zwaai-markering volgt alleen een ONTVANGEN zwaai', async () => {
  // Wel een ontvangen zwaai: markering.
  assert.ok((await render(draad())).includes('msg-thread-wave'), 'een ontvangen zwaai markeert de draad');
  // Geen zwaai: geen markering.
  const stil = draad();
  stil.messages = stil.messages.map((m) => ({ ...m, wave: false }));
  assert.equal((await render(stil)).includes('msg-thread-wave'), false, 'geen zwaai, geen teken');
  // Een zwaai die JIJ stuurde: ook geen markering, dat is geen uitnodiging
  // aan jezelf.
  const eigen = draad({ messages: [{ type: 'sent', to_handle: '@bart@pruts.nl', wave: true, created_at: '2026-08-25T10:00:00Z' }] });
  assert.equal((await render(eigen)).includes('msg-thread-wave'), false, 'een eigen zwaai zet geen teken');
});
