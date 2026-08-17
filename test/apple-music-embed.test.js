// Een Apple Music-AFSPEELLIJST kreeg geen embed maar de kale shortcode.
//
// Barts melding (17-8): het concept "The Mixtape" toonde in preview letterlijk
// [[embed:https://music.apple.com/nl/playlist/romance/pl.u-LdbqzVvI3go5g]].
//
// De keten: detectProvider herkende hem wel (die kijkt niet verder dan
// /playlist/), applemusicIframe eiste een NUMMER als id -- goed voor een album
// of nummer, maar een afspeellijst heet pl.u-LdbqzVvI3go5g -- en gaf null,
// waarna embedMediaShortcodes terugviel op de shortcode zelf. Twee fouten dus,
// en de tweede maakte de eerste onbegrijpelijk: een lezer ziet geen "dit kan
// ik niet", hij ziet rommel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { default: AudioEmbedService } = await import('../src/services/AudioEmbedService.js');

const PLAYLIST = 'https://music.apple.com/nl/playlist/romance/pl.u-LdbqzVvI3go5g';
const ALBUM = 'https://music.apple.com/nl/album/abbey-road/1441164426';

test('een afspeellijst wordt een echte iframe, geen shortcode', () => {
  const out = AudioEmbedService.embedMediaShortcodes(`[[embed:${PLAYLIST}]]`);
  assert.ok(!out.includes('[[embed:'), 'de shortcode staat er niet meer');
  assert.match(out, /embed\.music\.apple\.com\/nl\/playlist\/romance\/pl\.u-LdbqzVvI3go5g/);
  assert.match(out, /<iframe/);
});

test('een album met een numeriek id blijft werken', () => {
  // De reparatie mag de vorm die het WEL deed niet kwijtraken.
  const out = AudioEmbedService.embedMediaShortcodes(`[[embed:${ALBUM}]]`);
  assert.match(out, /embed\.music\.apple\.com\/nl\/album\/abbey-road\/1441164426/);
  assert.ok(!out.includes('[[embed:'));
});

test('wat we niet kunnen bouwen zegt dat, in plaats van de shortcode te tonen', () => {
  // Herkend als Apple Music (de detectie kijkt tot /playlist/), maar het id is
  // onbruikbaar. Vroeger: de kale shortcode op de pagina.
  const raar = 'https://music.apple.com/nl/playlist/romance/@@@';
  const out = AudioEmbedService.embedMediaShortcodes(`[[embed:${raar}]]`);
  assert.ok(!out.includes('[[embed:'), 'nooit de shortcode aan de lezer');
  assert.match(out, /post-embed-missing/);
});

test('het pad kan niet uit de embed-host breken', () => {
  // Wat gevangen wordt gaat rechtstreeks achter embed.music.apple.com/ aan,
  // dus geen slash, vraagteken of hekje in het id.
  for (const kwaad of [
    'https://music.apple.com/nl/playlist/x/pl.a/../../evil',
    'https://music.apple.com/nl/playlist/x/pl.a?next=https://evil.example',
    'https://music.apple.com/nl/playlist/x/pl.a#https://evil.example',
  ]) {
    const out = AudioEmbedService.embedMediaShortcodes(`[[embed:${kwaad}]]`);
    assert.ok(!/evil\.example/.test(out), `geen vreemde host uit ${kwaad}`);
  }
});
