// Een vreemde note mag nooit de hele pagina meenemen.
//
// Drie posts van een remote server droegen media_json = "[]": een JSON-STRING met
// daarin [], niet een array. De try/catch eromheen vangt kapotte json, maar niet
// geldige json van het verkeerde type: JSON.parse('"[]"') geeft netjes de string
// "[]" terug, en een string heeft geen .filter. Daarmee lag /news plat op beta.
//
// Wat er van een andere server binnenkomt is niet van ons. De vorm moet dus
// afgedwongen worden op het moment van gebruik, niet aangenomen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ejs from 'ejs';
import path from 'path';

const VIEWS = path.resolve('src/views');
const PARTIAL = path.join(VIEWS, 'partials/note-body.ejs');

// Alles wat note-body van een rij verwacht, met lege waarden. Per test overschrijven
// we alleen media_json, want daar gaat het hier om.
function rij(extra) {
  return {
    content: '<p>hoi</p>', media_json: null, emoji_json: null, quote_json: null,
    embed_json: null, nsfw: 0, cw: null, poll_json: null, link_json: null,
    ...extra,
  };
}

async function render(nb) {
  return ejs.renderFile(PARTIAL, {
    nb,
    noteQuote: () => null,
    emojiHtml: (html) => String(html || ''),
    thumb: (u) => String(u || ''),
    t: (k) => k,
    formatDate: (d) => String(d),
    formatDateTime: (d) => String(d),
  }, { async: true, views: [VIEWS] });
}

test('een media_json die een STRING is sloopt de pagina niet', async () => {
  // Precies wat er op beta stond.
  const html = await render(rij({ media_json: '"[]"' }));
  assert.match(html, /hoi/, 'de tekst van de post hoort er gewoon te staan');
});

test('een media_json die een OBJECT is sloopt de pagina niet', async () => {
  const html = await render(rij({ media_json: '{"url":"https://a.example/x.png"}' }));
  assert.match(html, /hoi/);
});

test('een media_json die een GETAL is sloopt de pagina niet', async () => {
  const html = await render(rij({ media_json: '42' }));
  assert.match(html, /hoi/);
});

test('kapotte json blijft ook gewoon werken', async () => {
  const html = await render(rij({ media_json: '{niet eens json' }));
  assert.match(html, /hoi/);
});

test('en een NORMALE lijst wordt nog steeds getoond', async () => {
  const html = await render(rij({
    media_json: JSON.stringify([{ url: 'https://a.example/plaatje.png', type: 'image/png' }]),
  }));
  assert.match(html, /plaatje\.png/, 'de fix mag geen media wegpoetsen die wel klopt');
});
