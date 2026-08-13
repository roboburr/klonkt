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

// ── Stap 2: de keuze vastleggen ───────────────────────────────────────────

test('alleen een echte MBID komt de kolom in', async () => {
  // De route weigert alles wat geen UUID is. Zonder die zeef sluipt er een
  // hele URL of een handle in het veld dat straks naar buiten gaat.
  const db = dbMod.default;
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'u1', 'u1@t', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'band', 'Band', 'u1');
  for (const rommel of ['https://musicbrainz.org/artist/8be31978-1884-4773-beae-f73df35b92aa', 'nirvana', '']) {
    assert.equal(MB.isMbid(rommel), false, `${rommel} hoort geweigerd te worden`);
  }
  db.prepare('UPDATE sites SET mb_artist_id = ?, mb_artist_name = ? WHERE id = ?')
    .run('8be31978-1884-4773-beae-f73df35b92aa', 'Nirvana', 's1');
  const s = db.prepare("SELECT mb_artist_id, mb_artist_name FROM sites WHERE id = 's1'").get();
  assert.equal(s.mb_artist_id, '8be31978-1884-4773-beae-f73df35b92aa');
  assert.equal(s.mb_artist_name, 'Nirvana', 'de naam ernaast, zodat het scherm kan tonen WAT er hangt');
});

test('ontkoppelen maakt beide velden leeg', () => {
  const db = dbMod.default;
  db.prepare('UPDATE sites SET mb_artist_id = NULL, mb_artist_name = NULL WHERE id = ?').run('s1');
  const s = db.prepare("SELECT mb_artist_id, mb_artist_name FROM sites WHERE id = 's1'").get();
  assert.equal(s.mb_artist_id, null);
  assert.equal(s.mb_artist_name, null, 'anders blijft er een naam staan zonder koppeling');
});

// ── Stap 3: op de draad ───────────────────────────────────────────────────

test('de actor draagt sameAs zodra er gekoppeld is -- en anders niets', async () => {
  const db = dbMod.default;
  const AP = await import('../src/services/ActivityPubService.js');
  const BASE = 'https://ons.test';
  const kaal = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  assert.equal(AP.buildActor(BASE, kaal).sameAs, undefined,
    'zonder koppeling staat er niets -- een lege verwijzing is erger dan geen');

  db.prepare('UPDATE sites SET mb_artist_id = ? WHERE id = ?')
    .run('8be31978-1884-4773-beae-f73df35b92aa', 's1');
  const gekoppeld = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const actor = AP.buildActor(BASE, gekoppeld);
  assert.equal(actor.sameAs, 'https://musicbrainz.org/artist/8be31978-1884-4773-beae-f73df35b92aa');
});

test('rommel in de kolom komt NIET op de draad', () => {
  // Het scherm zeeft al, maar de actor is de laatste deur. Wat hier langskomt
  // gaat naar iedereen, en een half adres is erger dan geen.
  const db = dbMod.default;
  db.prepare('UPDATE sites SET mb_artist_id = ? WHERE id = ?').run('nirvana', 's1');
  const s = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  assert.equal(MB.artiestUrl(s.mb_artist_id), null);
});

test('sameAs is een eigen term en NIET alsoKnownAs', async () => {
  // alsoKnownAs is in AS2 voor vroegere IDENTITEITEN van dezelfde actor, en
  // FEP-7628 leunt erop bij een verhuizing: het oude adres controleert of het
  // nieuwe hem daar noemt. Een MBID daar neerzetten zou een verhuizing kunnen
  // laten mislukken.
  const core = await import('../src/services/ap-core.js');
  const term = core.AP_CONTEXT.find((x) => x && typeof x === 'object' && x.sameAs);
  assert.ok(term, 'de term is gedeclareerd, anders laat een strikte lezer hem vallen');
  assert.equal(term.sameAs['@id'], 'schema:sameAs');
  assert.equal(term.sameAs['@type'], '@id', 'het is een URI en geen tekst');
});

// ── De terug-weg (Robins "social networking"-validatie) ───────────────────

test('een MBID in het zoekveld wordt rechtstreeks opgezocht', async () => {
  // Zoeken op een UUID levert bij MusicBrainz niets op, dus zonder deze tak
  // geeft plakken juist het slechtste resultaat.
  globalThis.fetch = async (url) => {
    verzoeken.push({ url: String(url) });
    return { ok: true, json: async () => ({ id: '8be31978-1884-4773-beae-f73df35b92aa', name: 'robo-burr', disambiguation: 'AKA roboburr' }) };
  };
  verzoeken.length = 0;
  const een = await MB.haalArtiest('8be31978-1884-4773-beae-f73df35b92aa');
  assert.equal(een.naam, 'robo-burr');
  assert.match(verzoeken[0].url, /\/artist\/8be31978-1884-4773-beae-f73df35b92aa\?/, 'de lookup, niet de zoekopdracht');
  assert.equal(await MB.haalArtiest('nirvana'), null, 'geen MBID, geen lookup');
});

test('de terug-weg is pas waar als de pagina ONS domein noemt', async () => {
  // Echt gemeten op 13-8: robo-burr heeft precies een url-relatie, type
  // "social network", naar sound-fabrics.com. Dus voor dev.klonkt.com hoort
  // hier false uit te komen -- en dat is de waarde van de controle.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ relations: [{ type: 'social network', url: { resource: 'https://sound-fabrics.com/' } }] }),
  });
  const mbid = '24abe2be-c0bc-4c63-9642-d6f89ec6a00a';
  const mis = await MB.controleerTerugweg(mbid, 'https://dev.klonkt.com');
  assert.equal(mis.verified, false, 'een andere site is geen terugweg');
  assert.deepEqual(mis.urls, ['https://sound-fabrics.com/']);

  const raak = await MB.controleerTerugweg(mbid, 'https://sound-fabrics.com');
  assert.equal(raak.verified, true, 'dezelfde host telt, ongeacht pad of slash');
});

test('niet kunnen kijken is niet hetzelfde als niet gevonden', async () => {
  // Bij een storing false EN een lege lijst -- nooit stilletjes "wederzijds".
  globalThis.fetch = async () => { throw new Error('weg'); };
  const uit = await MB.controleerTerugweg('24abe2be-c0bc-4c63-9642-d6f89ec6a00a', 'https://dev.klonkt.com');
  assert.deepEqual(uit, { verified: false, urls: [] });
});
