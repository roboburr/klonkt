/**
 * Hoe ver zijn we van Funkwhale's bibliotheek-ingest?
 *
 *   node scripts/funkwhale-gat.mjs https://dev.klonkt.com/ap/users/dev/library
 *
 * Loopt de eisen na die in api/funkwhale_api/federation/serializers.py staan
 * (develop, gelezen 16-8) en zegt per veld of het er is. Geen oordeel, geen
 * schatting: de lijst komt uit hun bron en de waarden uit onze eigen uitvoer.
 *
 * WAAROM DIT ER IS. "Zijn we er al?" is drie keer beantwoord met een gevoel en
 * drie keer bijgesteld. Deze vraag hoort een commando te zijn.
 *
 * LET OP wat dit NIET meet: de kanaal-weg. open.audio heeft onze tracks al
 * langs de outbox binnengehaald, met naam en artiest. Wat daar ontbreekt is
 * `uploads` -- en dat is precies wat deze ingest zou vullen.
 */
const BRON = process.argv[2] || 'https://dev.klonkt.com/ap/users/dev/library';

const haal = async (u) => {
  const r = await fetch(u, { headers: { Accept: 'application/activity+json' } });
  if (!r.ok) throw new Error(`${u} gaf ${r.status}`);
  return r.json();
};

// serializers.py regel 1741 -- UploadSerializer, per item in een bibliotheekpagina
const UPLOAD = [
  ['type', (a) => a.type === 'Audio'],
  ['id', (a) => !!a.id],
  ['library', (a) => !!a.library],
  ['url.href', (a) => !!(Array.isArray(a.url) ? a.url[0] : a.url)?.href],
  ['url.mediaType', (a) => !!(Array.isArray(a.url) ? a.url[0] : a.url)?.mediaType],
  ['published', (a) => !!a.published],
  ['duration', (a) => typeof a.duration === 'string'],
  // fw:bitrate en fw:size, en TOP-LEVEL. Wij zetten ze op de Link (waar hun
  // eigen outbox ze ook zet) en binden ze aan schema: -- zie shaer-f1y4.
  ['bitrate (top-level)', (a) => a.bitrate !== undefined],
  ['size (top-level)', (a) => a.size !== undefined],
  ['track', (a) => !!a.track],
];

// regel 1569 -- TrackSerializer, plus MusicEntitySerializer (1278) eronder
const TRACK = [
  ['track.id', (t) => !!t?.id],
  ['track.name', (t) => !!t?.name],
  ['track.published', (t) => !!t?.published],
  ['track.artist_credit[>=1]', (t) => Array.isArray(t?.artist_credit) && t.artist_credit.length >= 1],
  ['track.album', (t) => !!t?.album],
];

const lib = await haal(BRON);
const pagina = lib.first ? await haal(lib.first) : lib;
const items = pagina.items || pagina.orderedItems || [];
if (!items.length) { console.log('geen items in de bibliotheek'); process.exit(1); }

// ALLE items, niet het eerste. De eerste versie keek naar items[0] en gaf
// daarover een oordeel alsof het over de bibliotheek ging -- op 16-8 meldde hij
// zo `track.album` als GAT terwijl drie van de vier tracks hem wel hadden: het
// ene nummer dat hij toevallig pakte stond niet op een plaat. Een steekproef
// van een is geen meting, en een meting die je vertrouwt moet zeggen hoeveel.
console.log(`bron: ${BRON}\nitems: ${items.length}\n`);

let gaten = 0;
const toon = (kop, lijst, kies) => {
  console.log(kop);
  for (const [naam, test] of lijst) {
    let ok = 0;
    for (const a of items) { try { if (test(kies(a))) ok++; } catch { /* telt als niet ok */ } }
    const staat = ok === items.length ? 'OK ' : (ok === 0 ? 'GAT' : 'DEELS');
    if (ok !== items.length) gaten++;
    console.log(`  ${staat.padEnd(5)} ${naam}${ok !== items.length ? `  (${ok}/${items.length})` : ''}`);
  }
};
toon('UploadSerializer (regel 1741):', UPLOAD, (a) => a);
console.log();
toon('TrackSerializer (regel 1569 + MusicEntity 1278):', TRACK, (a) => a.track);

console.log(`\n${gaten === 0 ? 'niets meer nodig voor hun ingest' : gaten + ' veld(en) nog niet op ELK item'}`);
