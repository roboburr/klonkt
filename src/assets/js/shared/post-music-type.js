/**
 * De regel: welk soort uitgave is een post? (shaer-cyg)
 *
 * WAAROM DIT ONDER assets/ STAAT. De regel wordt op twee plaatsen gebruikt: de
 * server leidt er het type van bestaande posts mee af, en de editor laat het
 * type er live door volgen als je muziek invoegt. Dat MOET dezelfde regel zijn.
 * Twee kopieën zouden niet luidruchtig kapotgaan maar stil uit elkaar lopen --
 * de editor zegt album, de server zegt playlist, en niemand die het merkt. De
 * browser kan alleen bij /assets, de server kan overal bij; dus staat hij hier,
 * en importeert de server hem vanuit services/music.
 *
 * Deze module is bewust PUUR: geen database, geen DOM, geen fetch. Wie hem
 * gebruikt levert zelf een opzoeker voor de soort van een playlist.
 *
 * DE REGEL GAAT OVER IDENTITEIT, NIET OVER TELLEN (Robins herformulering, 9-8):
 * een post neemt het type van zijn muziek over als hij precies EEN muzikale
 * eenheid bevat. Zijn het er meer, dan is de post een post die naar muziek
 * verwijst, en houden de collecties hun eigen identiteit.
 *
 *   losse track(s)                -> playlist   metadata van de post geleend
 *   een collectie                 -> die soort  metadata van de post geleend
 *   een collectie + losse tracks  -> album      de losse zijn BONUS-TRACKS
 *   een MIXTAPE + losse tracks    -> mixtape    de losse zijn BONUS-TRACKS
 *   twee of meer collecties       -> post       NIETS geleend
 *
 * Die vierde regel is de uitzondering op de derde en staat er met opzet naast:
 * bonustracks maken van een uitgave een album, maar een bandje is geen uitgave.
 *
 * Waarom de lening bij de laatste vervalt: die bestaat omdat een collectie soms
 * dun is -- geen eigen hoes, geen eigen titel. Bij twee is de post niet meer de
 * drager van EEN identiteit, en vervalt de reden vanzelf.
 *
 * WIE KIEST ALBUM OF PLAYLIST: dat gebeurt wanneer de PLAYLIST wordt gemaakt.
 * Die keuze staat in playlists.kind en wordt hier OPGEZOCHT, niet afgeleid --
 * een post om een album is een album, ook al heet de shortcode [[playlist:...]].
 *
 * EN ALS WE HET NIET WETEN: een gewone post met insluitingen die de post als
 * context hebben. Geen noodgreep maar de rustende toestand; tracks wijzen met
 * `context` toch al terug naar hun post, dus er gaat niets verloren.
 */

// Dezelfde patronen als de renderer in AudioEmbedService: wat daar niet
// insluit, telt hier niet mee. Anders zou een shortcode die niets oplevert wel
// het type van de post kunnen bepalen.
// De soorten die een playlist kan zijn, en dit is de ENIGE lijst. PlaylistService
// en music/index.js halen hem hier op, precies omdat het andersom niet kan:
// deze module draait ook in de browser en mag niets van de database weten.
//
// Waarom dat uitmaakt: bij twee soorten stond de keuze vijf keer als
// `x === 'playlist' ? 'playlist' : 'album'` verspreid over drie bestanden. Zo'n
// vorm valt niet om bij een derde soort, hij slikt hem -- een mixtape werd
// stilzwijgend een album en ging als Album de deur uit.
export const SOORTEN = ['album', 'playlist', 'mixtape'];

const RE_PLAYLIST = /\[\[playlist:([a-z0-9][a-z0-9-]*)\]\]/gi;
const RE_ALBUM    = /\[\[album:([^\]]+)\]\]/g;
const RE_TRACK    = /\[\[track:([A-Za-z0-9_-]+)\]\]/g;

/**
 * @param {string} content    de HTML/tekst van de post
 * @param {(id: string) => ('album'|'playlist'|null)} kindVan
 *        de gekozen soort van een playlist, of null als hij onbekend is
 * @returns {null|{type, collectie?, collecties?, tracks, bonus, onbekend?, leentMetadata}}
 */
export function afleidenUitInsluitingen(content, kindVan) {
  const c = String(content || '');
  const zoek = typeof kindVan === 'function' ? kindVan : () => null;
  const uniek = (re) => [...new Set([...c.matchAll(re)].map((m) => m[1].trim()))];

  const playlists = uniek(RE_PLAYLIST);
  const albums    = uniek(RE_ALBUM);
  const tracks    = uniek(RE_TRACK);

  if (!playlists.length && !albums.length && !tracks.length) return null;

  // De soort van een playlist is een gegeven, geen afleiding.
  const onbekend = [];
  const uitPlaylists = playlists.map((id) => {
    const kind = zoek(id);
    if (!SOORTEN.includes(kind)) { onbekend.push(id); return null; }
    return { soort: kind, id };
  }).filter(Boolean);

  const collecties = [
    ...uitPlaylists,
    ...albums.map((naam) => ({ soort: 'album', naam })),
  ];

  // Onbekende situatie -> gewone post. De insluitingen blijven staan en houden
  // de post als context; alleen het label wordt niet verzonnen.
  if (onbekend.length) {
    return { type: 'post', collecties, tracks, bonus: [], onbekend, leentMetadata: false };
  }

  if (!collecties.length) {
    // Ook EEN losse track wordt een playlist: naar buiten toe is er dan altijd
    // een collectie om naar te wijzen. Hoe Klonkt dat toont is een aparte vraag.
    return { type: 'playlist', collectie: null, tracks, bonus: [], leentMetadata: true };
  }

  if (collecties.length === 1) {
    const c0 = collecties[0];
    // EEN MIXTAPE BLIJFT EEN MIXTAPE, ook met losse tracks erbij. De regel
    // hieronder maakt van collectie + losse tracks een album met bonustracks, en
    // dat klopt voor een uitgave: extra nummers bij een plaat zijn bonus. Een
    // bandje is geen uitgave. Er een album van maken omdat er een los nummer
    // naast staat zou het ding hernoemen op grond van iets wat er niet bij
    // hoort. Album en playlist houden bewust hun oude gedrag: dat zijn
    // bestaande posts en die mogen hier niet stilletjes van soort wisselen.
    if (c0.soort === 'mixtape') {
      return { type: 'mixtape', collectie: c0, tracks: [], bonus: tracks, leentMetadata: true };
    }
    // Losse tracks naast een collectie zijn geen rommelrestje maar bonus-tracks,
    // en dat maakt het geheel een album.
    if (tracks.length) return { type: 'album', collectie: c0, tracks: [], bonus: tracks, leentMetadata: true };
    return { type: c0.soort, collectie: c0, tracks: [], bonus: [], leentMetadata: true };
  }

  return { type: 'post', collecties, tracks, bonus: [], leentMetadata: false };
}

/** De playlist-ids die in een tekst worden ingesloten. */
export function ingeslotenPlaylists(content) {
  return [...new Set([...String(content || '').matchAll(RE_PLAYLIST)].map((m) => m[1].trim()))];
}
