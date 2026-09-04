// De negatieve dereference-cache mocht geen censuurknop zijn (shaer-qawr).
//
// DE AANVAL. Neem de echte note-URI van je slachtoffer, zet je eigen actor op
// dezelfde host als beweerde afzender, en wijs met inReplyTo naar een van onze
// publieke notes. De fetch bij de bron SLAAGT, maar attributedTo is het
// slachtoffer en niet jij: een mismatch. Werd die op de note-URI alleen
// onthouden, dan stond die dertig minuten op de zwarte lijst en liep het ECHTE
// doorgestuurde antwoord daarop stuk. Elke dertig minuten herhalen gaf
// onbeperkte, gerichte onderdrukking van een specifiek antwoord.
//
// Op de cache getoetst en niet via handleInbox: de weg erheen eist https en een
// echte fetch bij een vreemde host, en dat is in een toets geen bewijs maar een
// netwerkafspraak. Deze twee functies ZIJN de kwetsbaarheid.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const { _derefCacheForTests } = await import('../src/services/ap-inbox.js');
const { derefRecentlyFailed, noteDerefFailure } = _derefCacheForTests;

const NOTE = 'https://mastodon.example/users/slachtoffer/statuses/1';
const AANVALLER = 'https://mastodon.example/users/aanvaller';
const DOORSTUURDER = 'https://mastodon.example/users/draadstarter';

test('een uitgelokte mismatch blokkeert het echte antwoord niet', () => {
  // De aanvaller lokt de mismatch uit op de note van het slachtoffer.
  noteDerefFailure(NOTE, AANVALLER);

  // Zijn eigen herhaling wordt wel geremd -- dat was het doel van de cache.
  assert.equal(derefRecentlyFailed(NOTE, AANVALLER), true,
    'dezelfde leugen nog eens kost geen tweede fetch');

  // Maar het echte doorgestuurde antwoord, van de draadstarter, komt er langs.
  assert.equal(derefRecentlyFailed(NOTE, DOORSTUURDER), false,
    'een vreemde mag deze note niet voor een ander op slot zetten');
});

test('een transportfout geldt wel voor iedereen', () => {
  // De note is niet op te halen. Dat is een eigenschap van de note zelf, dus
  // die remt elke doorstuurder -- daar is de cache voor.
  const stuk = 'https://mastodon.example/users/x/statuses/onbereikbaar';
  noteDerefFailure(stuk);
  assert.equal(derefRecentlyFailed(stuk, DOORSTUURDER), true);
  assert.equal(derefRecentlyFailed(stuk, AANVALLER), true);
});

test('de rem remt: een andere query is dezelfde ingang', () => {
  // Met een kale URL als sleutel waren ?x=1 en ?x=2 losse ingangen, en dan kost
  // varieren niets en is er geen rem.
  const basis = 'https://mastodon.example/users/y/statuses/9';
  noteDerefFailure(`${basis}?x=1`);
  assert.equal(derefRecentlyFailed(`${basis}?x=2`, DOORSTUURDER), true, 'query telt niet mee');
  assert.equal(derefRecentlyFailed(`${basis}#frag`, DOORSTUURDER), true, 'fragment ook niet');
  // De HOST wel, want dat is een ander adres en een andere partij.
  assert.equal(derefRecentlyFailed('https://elders.example/users/y/statuses/9', DOORSTUURDER), false);
  // Het PAD ook, anders zou een mislukking de buren meenemen.
  assert.equal(derefRecentlyFailed('https://mastodon.example/users/y/statuses/10', DOORSTUURDER), false);
});
