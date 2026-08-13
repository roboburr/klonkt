/**
 * Een artiest zoekt zichzelf op in MusicBrainz (shaer-mbz).
 *
 * WAAROM DIT GEEN DIALECT IS. Funkwhale's Track/Artist/ArtistCredit zijn hun
 * eigen vocabulaire -- hun docs noemen ze letterlijk "Custom Funkwhale object"
 * -- en wij kunnen ze niet eerlijk vullen: artiest en album zijn bij ons
 * tekstkolommen, geen entiteiten. Een MBID is iets anders: geen vocabulaire
 * maar een REGISTER. Ernaar verwijzen is als een ISBN noemen. Je neemt niemands
 * model over en je wijst naar iets dat al bestaat.
 *
 * WAT HIER NIET GEBEURT: schrijven. Via hun API zijn alleen tags, ratings,
 * ISRC's en barcodes in te dienen -- artiesten, releases en recordings niet,
 * dat gaat via hun website. Wij lezen dus alleen, en dat is meteen de
 * geruststelling: we kunnen hun register niet vervuilen.
 *
 * TWEE HARDE REGELS VAN HUN KANT, allebei hieronder ingebakken omdat ze bij
 * overtreding tot blokkade leiden en niet tot een foutmelding:
 *   - hoogstens EEN verzoek per seconde, per applicatie (niet per bezoeker)
 *   - een echte User-Agent, met contactgegevens
 */
import { safeFetch } from './ActivityPubService.js';

const BASIS = 'https://musicbrainz.org/ws/2';

/**
 * De User-Agent die MusicBrainz eist. Hun regel: naam, versie en een manier om
 * contact op te nemen. Een lege of generieke string is precies waarop ze
 * blokkeren, dus als er geen contact is ingesteld zeggen we dat met zoveel
 * woorden in plaats van iets aardigs te verzinnen.
 */
function userAgent() {
  const contact = (process.env.MUSICBRAINZ_CONTACT || '').trim()
    || (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
    || 'geen-contact-ingesteld';
  return `Klonkt/1.0 ( ${contact} )`;
}

/**
 * Hun tempo aanhouden: ten hoogste een verzoek per seconde, over de HELE
 * applicatie. Geen bibliotheek en geen wachtrij -- een belofte die de volgende
 * aanroeper laat wachten tot het weer mag. Zonder dit is de eerste drukke dag
 * meteen een blokkade, en dan werkt het bij iedereen niet meer.
 */
let laatste = 0;
let beurt = Promise.resolve();
function opDeBeurt() {
  beurt = beurt.then(async () => {
    const wachten = 1000 - (Date.now() - laatste);
    if (wachten > 0) await new Promise((r) => setTimeout(r, wachten));
    laatste = Date.now();
  });
  return beurt;
}

/**
 * Zoek artiesten op naam. Geeft de kandidaten met alles wat nodig is om er EEN
 * uit te kiezen -- de naam alleen is niet genoeg, want er zijn drie bands die
 * Nirvana heten. Vandaar disambiguation, land en de jaren erbij.
 *
 * Geeft een LEGE lijst bij een storing, geen exceptie: niet kunnen zoeken is
 * vervelend, maar het mag het beheerscherm niet omvergooien.
 */
export async function zoekArtiesten(naam, { limit = 8 } = {}) {
  const q = String(naam || '').trim();
  if (!q) return [];
  const url = `${BASIS}/artist?query=${encodeURIComponent(q)}&fmt=json&limit=${Math.min(25, Math.max(1, limit))}`;
  try {
    await opDeBeurt();
    const r = await safeFetch(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent() } });
    if (!r || !r.ok) return [];
    const doc = await r.json();
    return (doc.artists || []).map(kandidaat).filter(Boolean);
  } catch {
    return [];
  }
}

/** Een kandidaat, teruggebracht tot wat een mens nodig heeft om te kiezen. */
function kandidaat(a) {
  if (!a || !a.id || !a.name) return null;
  const jaren = [a['life-span']?.begin, a['life-span']?.ended ? a['life-span']?.end : null]
    .filter(Boolean).join(' – ');
  return {
    mbid: a.id,
    naam: a.name,
    // "disambiguation" is het veld waarmee MusicBrainz zelf twee gelijknamige
    // artiesten uit elkaar houdt. Precies wat de kiezer nodig heeft.
    toelichting: a.disambiguation || '',
    soort: a.type || '',            // Person, Group, ...
    land: a.country || '',
    jaren,
    url: `https://musicbrainz.org/artist/${a.id}`,
    // Hun eigen zoekscore. Niet om op te sorteren -- dat doen zij al -- maar om
    // een zwakke treffer te kunnen tonen als zwak.
    score: Number(a.score) || 0,
  };
}

/** Is dit een MBID? Een UUID, en niets anders. */
export function isMbid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || '').trim());
}

/** De publieke pagina van een artiest, of null als het geen MBID is. */
export function artiestUrl(mbid) {
  return isMbid(mbid) ? `https://musicbrainz.org/artist/${String(mbid).trim().toLowerCase()}` : null;
}

export default { zoekArtiesten, isMbid, artiestUrl };
