// De MusicBrainz-koppeling, stap 1 (shaer-mbz).
//
// Zonder netwerk: globalThis.fetch wordt vervangen en musicbrainz.org staat in
// AP_ALLOW_HOSTS, zodat safeFetch geen DNS doet. Anders test dit of de
// testmachine internet heeft en of MusicBrainz toevallig up is.
//
// Wat hier WEL getest wordt is wat wij beloven: hun twee harde regels. Die
// leiden bij overtreding tot een BLOKKADE en niet tot een foutmelding, dus
// "het werkte toen ik het probeerde" is er geen bewijs voor.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';
process.env.MUSICBRAINZ_CONTACT = 'robin@ons.test';
process.env.AP_ALLOW_HOSTS = 'musicbrainz.org';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const MB = await import('../src/services/MusicBrainzService.js');

const verzoeken = [];
const echt = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  verzoeken.push({ url: String(url), ua: opts?.headers?.['User-Agent'], op: Date.now() });
  return {
    ok: true,
    status: 200,
    headers: new Map(),
    json: async () => ({
      artists: [
        { id: '8be31978-1884-4773-beae-f73df35b92aa', name: 'Nirvana', score: 100,
          disambiguation: 'Seattle grunge band', type: 'Group', country: 'US',
          'life-span': { begin: '1987', ended: true, end: '1994' } },
        { id: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'Nirvana', score: 72,
          disambiguation: '60s UK band', type: 'Group', country: 'GB' },
        { id: 'bad', name: '' },   // onbruikbaar: moet eruit vallen
      ],
    }),
  };
};

test('een MBID is een UUID en niets anders', () => {
  assert.equal(MB.isMbid('8be31978-1884-4773-beae-f73df35b92aa'), true);
  assert.equal(MB.isMbid('the_ceeesg'), false, 'een handle is geen MBID');
  assert.equal(MB.isMbid('https://musicbrainz.org/artist/8be31978-1884-4773-beae-f73df35b92aa'), false,
    'een URL ook niet -- anders sluipt er een hele link de kolom in');
  assert.equal(MB.isMbid(''), false);
  assert.equal(MB.isMbid(null), false);
});

test('de artiest-URL wordt alleen uit een echte MBID gebouwd', () => {
  assert.equal(MB.artiestUrl('8BE31978-1884-4773-BEAE-F73DF35B92AA'),
    'https://musicbrainz.org/artist/8be31978-1884-4773-beae-f73df35b92aa',
    'kleingeschreven, want een MBID is er een en niet twee');
  assert.equal(MB.artiestUrl('rommel'), null, 'geen URL verzinnen om iets onbekends heen');
});

test('een lege zoekopdracht raakt het net niet eens', async () => {
  verzoeken.length = 0;
  assert.deepEqual(await MB.zoekArtiesten('   '), []);
  assert.equal(verzoeken.length, 0, 'hun tempo is te kostbaar om aan niets te besteden');
});

test('de User-Agent noemt Klonkt EN een contact -- hun eis', async () => {
  // Een generieke of lege User-Agent is precies waarop MusicBrainz blokkeert.
  verzoeken.length = 0;
  await MB.zoekArtiesten('iemand');
  const ua = verzoeken.at(-1)?.ua;
  assert.ok(ua, 'er is er een gezet');
  assert.match(ua, /^Klonkt\//, 'met onze naam voorop');
  assert.match(ua, /robin@ons\.test/, 'en een manier om contact op te nemen');
});

test('de kandidaten dragen wat een mens nodig heeft om te KIEZEN', async () => {
  const uit = await MB.zoekArtiesten('Nirvana');
  assert.equal(uit.length, 2, 'een naamloze treffer is geen kandidaat');
  assert.equal(uit[0].mbid, '8be31978-1884-4773-beae-f73df35b92aa');
  // De naam alleen is niet genoeg: er zijn drie bands die Nirvana heten.
  assert.equal(uit[0].toelichting, 'Seattle grunge band');
  assert.equal(uit[1].toelichting, '60s UK band');
  assert.equal(uit[0].jaren, '1987 – 1994');
  assert.equal(uit[1].jaren, '', 'een band die nog bestaat krijgt geen eindjaar aangepraat');
  assert.equal(uit[0].url, 'https://musicbrainz.org/artist/8be31978-1884-4773-beae-f73df35b92aa');
});

test('twee zoekopdrachten liggen minstens een seconde uit elkaar', async () => {
  // Hun harde regel, en de reden dat dit server-side draait: een verzoek per
  // seconde geldt per APPLICATIE, niet per bezoeker. Twee tabbladen tegelijk
  // zouden hem anders samen overtreden.
  verzoeken.length = 0;
  await Promise.all([MB.zoekArtiesten('een'), MB.zoekArtiesten('twee')]);
  assert.equal(verzoeken.length, 2);
  const gat = verzoeken[1].op - verzoeken[0].op;
  assert.ok(gat >= 990, `verwacht >= 1000ms tussen twee verzoeken, was ${gat}ms`);
});

test.after(() => { globalThis.fetch = echt; });
