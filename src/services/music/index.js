/**
 * De muziekkant van ActivityPub: een track als AS2-object, de collecties
 * eromheen, en welke post hem uitbrengt.
 *
 * Waarom een eigen map (shaer-drc): ActivityPubService was 6400 regels over
 * tweeentwintig onderwerpen. Dit is het eerste onderwerp dat er als geheel uit
 * kan, en het is meteen het onderwerp dat gaat GROEIEN -- de typering uit
 * shaer-cyg (playlist versus album, afgeleid uit wat er in de post staat) landt
 * hier straks.
 *
 * De regel die guardianship al aanhoudt geldt hier ook: deze map importeert
 * alleen db en ap-core, en NOOIT terug uit ActivityPubService.
 */

import db from '../../config/database.js';
import { AP_CONTEXT, PUBLIC, actorId, noteId, safeUrl, guessMediaType, buildHashtagList, pagedCollection, isMbid } from '../ap-core.js';
import { afleidenUitInsluitingen, ingeslotenPlaylists } from '../../assets/js/shared/post-music-type.js';
// De luisteraars horen bij de muziekkant; hier doorgegeven zodat
// ActivityPubService niet in een submap hoeft te grijpen.
export * as luisteraars from './luisteraars.js';

// m.size hoort erbij voor de RSS-enclosure: die eist een lengte in bytes.
export const TRACK_KOLOMMEN = `t.id, t.title, t.artist, t.duration, t.cover_url, t.created_at,
     t.position, t.license,
     m.filename, m.storage_path, m.mime_type, m.size`;

/**
 * `alles` net als bij siteOpenTracks (FEP-1580): zonder die tak krijgt de
 * instantie waar je naartoe verhuist een playlist met gaten erin, want alleen
 * de opengezette nummers zitten erin. Een halve plaat is geen plaat.
 */
export function playlistOpenTracks(playlistId, { alles = false } = {}) {
  return db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
     FROM playlist_tracks pt
     JOIN audio_tracks t ON t.id = pt.track_id
     JOIN media m ON m.id = t.media_id
     WHERE pt.playlist_id = ?${alles ? '' : ' AND t.fedi_open = 1'}
     ORDER BY pt.position`
  ).all(playlistId);
}

/**
 * Alle tracks die deze site aan de federatie heeft opengezet (shaer-0nh, stap 3).
 *
 * Dit is de KANONIEKE plek, niet de playlist: een playlist is een keuze, dit is
 * wat de artiest heeft uitgebracht. Een track die in geen enkele playlist zit
 * was tot nu toe onzichtbaar voor de federatie -- die staat hier wel.
 */
/**
 * `alles` bestaat voor FEP-1580. Bij een verhuizing behandelt de bron een
 * ondertekend verzoek van de DOEL-actor als zichzelf, en dat geldt hier net zo
 * goed als bij de outbox. Zonder deze tak neemt een verhuizing alleen je
 * opengezette nummers mee en blijft je hele gesloten bibliotheek achter op een
 * domein dat je gaat opzeggen. De poort blijft verder dicht: alleen die ene
 * actor, en alleen omdat moveAccount() een terugverwijzing eiste voordat
 * moved_to er kwam te staan.
 */
export function siteOpenTracks(siteId, { alles = false } = {}) {
  return db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
     FROM audio_tracks t JOIN media m ON m.id = t.media_id
     WHERE t.site_id = ?${alles ? '' : ' AND t.fedi_open = 1'}
     ORDER BY t.position, t.created_at, t.id`
  ).all(siteId);
}

export function openTrack(siteId, trackId) {
  return db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
     FROM audio_tracks t JOIN media m ON m.id = t.media_id
     WHERE t.site_id = ? AND t.id = ? AND t.fedi_open = 1`
  ).get(siteId, trackId);
}

/**
 * Eén track als AS2 `Audio`, met een EIGEN id (shaer-0nh, stap 3).
 *
 * Waarom dat id het verschil maakt: zonder id is een track een naamloze bijlage
 * die alleen bestaat zolang je het omhullende object vasthoudt. Met id is het
 * een ding waar je naar kunt wijzen, dat je los kunt ophalen, en dat in twee
 * playlists hetzelfde ding is. Funkwhale adresseert zijn Audio-objecten
 * precies zo, per stuk, in Create en Delete.
 *
 * `url` is een Link-ARRAY, net als bij Funkwhale en net als wat onze eigen
 * inbox sinds bdcb3a3 verwacht: de mediaType hoort bij de link, niet bij het
 * object. Er zit GEEN text/html-link in: Klonkt heeft geen trackpagina -- een
 * track wordt getoond binnen een post, en een post over vijf nummers is niet de
 * pagina van dit ene nummer. Liever geen link dan een link die iets anders
 * belooft.
 */
/**
 * Bij welke post hoort een track? (shaer-0nh)
 *
 * Een track staat nooit los in Klonkt: hij wordt getoond BINNEN een post, via
 * een van drie insluitingen in posts.content. Die relatie stond alleen in die
 * tekst en nergens op de draad -- waardoor Shaer, dat zijn feed uit de outbox
 * bouwt, sinds fb22f78 losse Audio-kaarten kreeg zonder inhoud.
 *
 * ALLES IN EEN ZOEKOPDRACHT, niet per track. De collectie loopt over elke open
 * track, en drie LIKE-scans per stuk wordt bij tweehonderd nummers zeshonderd
 * scans. Nu is het er een, en de map gaat mee als optie.
 *
 * De rang bepaalt welke post wint als er meerdere zijn: rechtstreeks ingesloten
 * is specifieker dan via een playlist, en die weer specifieker dan via een
 * albumnaam. Bij gelijke rang de nieuwste post -- dat is waar iemand hem het
 * laatst heeft uitgebracht.
 */
export function trackHostPosts(siteId) {
  const rijen = db.prepare(`
    SELECT tid, post_id, post_slug, rang, wanneer FROM (
      SELECT t.id AS tid, p.id AS post_id, p.slug AS post_slug, 1 AS rang,
             COALESCE(p.published_at, p.created_at) AS wanneer
        FROM audio_tracks t
        JOIN posts p ON p.site_id = t.site_id AND p.status = 'published'
                    AND p.content LIKE '%[[track:' || t.id || ']]%'
       WHERE t.site_id = ? AND t.fedi_open = 1
      UNION ALL
      SELECT t.id, p.id, p.slug, 2, COALESCE(p.published_at, p.created_at)
        FROM playlist_tracks pt
        JOIN audio_tracks t ON t.id = pt.track_id
        JOIN posts p ON p.site_id = t.site_id AND p.status = 'published'
                    AND p.content LIKE '%[[playlist:' || pt.playlist_id || ']]%'
       WHERE t.site_id = ? AND t.fedi_open = 1
      UNION ALL
      SELECT t.id, p.id, p.slug, 3, COALESCE(p.published_at, p.created_at)
        FROM audio_tracks t
        JOIN posts p ON p.site_id = t.site_id AND p.status = 'published'
                    AND p.content LIKE '%[[album:' || t.album || ']]%'
       WHERE t.site_id = ? AND t.fedi_open = 1 AND t.album IS NOT NULL AND t.album <> ''
    ) ORDER BY rang, wanneer DESC
  `).all(siteId, siteId, siteId);
  const uit = new Map();
  for (const r of rijen) if (!uit.has(r.tid)) uit.set(r.tid, { id: r.post_id, slug: r.post_slug });
  return uit;
}

/**
 * De artiest-credit, gedeeld door track en album (shaer-3f8a / shaer-756s).
 *
 * De ENTITEIT is de site-actor: een echt, opvraagbaar adres. De credittekst --
 * de artiestkolom van de track of van de uitgave -- gaat naar `credit`, want
 * daar verwacht hun model hem. Er een id per artiestnaam van maken zou
 * identiteit uit een string zijn, en dat is de fout die we bij albums juist
 * vermijden.
 *
 * Eén functie voor beide, zodat een track en het album waar hij op staat nooit
 * een verschillende artiest kunnen krijgen door twee keer hetzelfde te bouwen.
 */
function artistCredit(base, site, creditTekst, wanneer) {
  const artiest = {
    type: 'Artist',
    id: actorId(base, site.slug),
    name: site.title || site.slug,
    published: site.created_at ? new Date(site.created_at).toISOString() : wanneer,
  };
  if (isMbid(site.mb_artist_id)) artiest.musicbrainzId = String(site.mb_artist_id).trim().toLowerCase();
  return [{
    type: 'ArtistCredit',
    id: `${actorId(base, site.slug)}#artist-credit`,
    published: artiest.published,
    artist: artiest,
    ...(creditTekst ? { credit: creditTekst } : {}),
  }];
}

export function buildTrackAudio(base, site, r, opts = {}) {
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
  const fn = r.filename || (r.storage_path || '').split('/').pop();
  // De bestandsgegevens horen bij de LINK, niet bij het object: het is die ene
  // representatie die zoveel bytes is en die bitrate heeft, niet het nummer.
  // Zo doet Funkwhale het ook.
  // De post waar dit nummer in staat. Meegegeven door de collectie (een
  // zoekopdracht voor alles), of hier opgezocht als deze track los wordt
  // opgehaald. `hostPosts` mag expliciet null zijn: dan is er niets te zoeken.
  const post = opts.hostPosts !== undefined
    ? (opts.hostPosts && opts.hostPosts.get(r.id)) || null
    : ((site.id && trackHostPosts(site.id).get(r.id)) || null);

  const bestand = { type: 'Link', href: `${base}/audio/stream/${encodeURIComponent(fn)}`, mediaType: r.mime_type || 'audio/mpeg' };
  if (Number(r.size)) bestand.size = Number(r.size);
  // Bitrate leiden we af uit bytes en seconden. Geen gok: voor een bestand IS
  // dat de gemiddelde bitrate, en bij CBR ook de echte. Alleen als we allebei
  // de getallen hebben -- liever geen veld dan een verzonnen getal.
  if (Number(r.size) && Number(r.duration)) bestand.bitrate = Math.round((Number(r.size) * 8) / Number(r.duration));

  const a = {
    ...(opts.standalone ? { '@context': AP_CONTEXT } : {}),
    id: `${actorId(base, site.slug)}/tracks/${encodeURIComponent(r.id)}`,
    type: 'Audio',
    name: r.title || 'Audio',
    attributedTo: actorId(base, site.slug),
    // Op het OBJECT, niet alleen op de omhullende Create: een los opgehaalde
    // track moet zelf kunnen zeggen dat hij openbaar is.
    to: [PUBLIC],
    // De post die dit nummer uitbrengt staat VOORAAN als text/html, precies
    // zoals Funkwhale zijn trackpagina zet. Wij hadden dat veld leeg gelaten
    // omdat Klonkt geen trackpagina heeft -- maar de post IS waar je het kunt
    // horen, en dat is wat zo'n link betekent.
    url: [...(post ? [{ type: 'Link', href: `${base}/${post.slug}`, mediaType: 'text/html' }] : []), bestand],
  };
  // De bak waar dit bestand in hangt (shaer-0nh). Voor Funkwhale is dit het
  // haakje waaraan een upload komt te zitten; zonder dit veld blijft een track
  // daar een naam zonder geluid.
  a.library = libraryId(base, site);
  if (r.artist) a.summary = r.artist;              // artiest als summary: kaal AS2, geen eigen vocab
  // AS2-kern `context`: "de context waarbinnen dit object bestaat". Voor een
  // track is dat de post die hem uitbrengt. Daarmee is de relatie die tot nu
  // toe alleen in posts.content stond, op de draad te zien -- en kan een lezer
  // die de post al heeft dit nummer overslaan in plaats van er een lege kaart
  // van te maken.
  if (post) a.context = noteId(base, post.id);
  // Het NUMMER, los van dit bestand (shaer-3f8a, spoor B). Funkwhale en
  // Emissary lezen allebei `fw:track`, en petitminion noemde het ontbreken
  // ervan als eerste wat hem opviel aan onze objecten.
  //
  // EIGEN ID MET #track, en niet hetzelfde id als de Audio. Emissary hergebruikt
  // daar het object-id, maar dan zijn in JSON-LD de Audio en de Track EEN knoop
  // met twee typen -- en een bestand is geen werk. Dat verschil moeten we straks
  // toch maken, want een album verzamelt nummers en geen mp3's. Een fragment is
  // een geldige IRI en wijst naar hetzelfde document.
  //
  // GEEN `album`. Dat veld is bij hen een URI naar een Album-object en bij ons
  // een tekstkolom; er hier een adres van maken zou een ding beloven dat niet
  // bestaat. Zie shaer-k37k -- dat is de keuze die daarvoor eerst moet vallen.
  //
  // WIE IS DE ARTIEST. Hun Artist is een ENTITEIT met een id, en bij ons is een
  // artiest een tekstkolom op de track. Die twee verzoenen we zo: de entiteit
  // is de site-ACTOR -- een echt, opvraagbaar adres, het account dat dit
  // uitbrengt -- en de tekst uit de kolom gaat naar `credit`, want dat is
  // precies waar hun model de credittekst verwacht.
  //
  // Dat is eerlijk en het is niet nieuw: open.audio leidde op 13-8 al zelf een
  // artist_credit af uit onze attributedTo. We maken alleen expliciet wat daar
  // toch al gebeurde.
  //
  // DE GRENS ERVAN: brengt een site werk van iemand anders uit, dan zegt dit
  // dat de site de artiest is. Dat stond al in attributedTo, dus we maken het
  // niet erger -- maar het is wel de reden dat we hier geen id per artiestnaam
  // verzinnen. Identiteit uit een string is dezelfde fout als bij het album
  // (shaer-756s).
  const wanneer = r.created_at ? new Date(r.created_at).toISOString()
    : (site.created_at ? new Date(site.created_at).toISOString() : new Date(0).toISOString());

  a.track = {
    type: 'Track',
    id: `${a.id}#track`,
    name: a.name,
    published: wanneer,
    ...(Number(r.position) ? { position: Number(r.position) } : {}),
    artist_credit: artistCredit(base, site, r.artist, wanneer),
  };
  // De uitgave waar dit nummer op staat, INGESLOTEN (shaer-756s, stap 2).
  // `albums` mag expliciet null zijn: dan is er niets op te zoeken.
  const uitgave = opts.albums !== undefined
    ? (opts.albums && opts.albums.get(r.id)) || null
    : ((site.id && trackAlbums(site.id).get(r.id)) || null);
  if (uitgave) {
    a.track.album = buildAlbumObject(base, site, uitgave);
    // Ook op het Audio-object zelf, als URI. Funkwhale 2.0 en Emissary doen dat
    // allebei, en het scheelt een lezer het uitpakken van de track.
    a.album = a.track.album.id;
  }
  if (r.duration) a.duration = `PT${Math.round(r.duration)}S`;
  if (r.created_at) a.published = new Date(r.created_at).toISOString();
  if (Number(r.position)) a.position = Number(r.position);
  const lic = licentieUri(r.license);
  if (lic) a.license = lic;
  const art = abs(r.cover_url || opts.coverFallback || null);
  // icon EN image: allebei AS2-kern. Wij gebruikten alleen icon; Funkwhale
  // leest image. Dezelfde hoes, twee namen, niemand die iets misloopt.
  if (art) {
    const plaat = { type: 'Image', mediaType: guessMediaType(art), url: art };
    a.icon = plaat;
    a.image = plaat;
  }
  return a;
}

/**
 * Onze licentie is VRIJE TEKST uit een keuzelijst ("CC BY 4.0", "Alle rechten
 * voorbehouden"); schema.org en Funkwhale willen een URI. Alleen de waarden die
 * onze eigen keuzelijst aanbiedt worden vertaald -- die kennen we exact. Al het
 * andere levert niets op: een zelfbedachte licentie-URI is erger dan geen, want
 * een lezer gelooft hem.
 */
const LICENTIES = {
  'cc0 1.0 (publiek domein)': 'http://creativecommons.org/publicdomain/zero/1.0/',
  'cc by 4.0': 'http://creativecommons.org/licenses/by/4.0/',
  'cc by-sa 4.0': 'http://creativecommons.org/licenses/by-sa/4.0/',
  'cc by-nc 4.0': 'http://creativecommons.org/licenses/by-nc/4.0/',
  'cc by-nc-sa 4.0': 'http://creativecommons.org/licenses/by-nc-sa/4.0/',
  'cc by-nd 4.0': 'http://creativecommons.org/licenses/by-nd/4.0/',
};
export function licentieUri(waarde) {
  const s = String(waarde || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeUrl(s);   // iemand vulde al een URI in
  return LICENTIES[s.toLowerCase()] || null;        // "Alle rechten voorbehouden" heeft er geen
}

/** Het AS2-id van de bibliotheek van een site. */
export function libraryId(base, site) {
  return `${actorId(base, site.slug)}/library`;
}

/**
 * De site als Funkwhale-LIBRARY (skelet).
 *
 * WAAROM DIT GEEN DIALECT IS ZOALS track EN ArtistCredit DAT WEL ZIJN. Die twee
 * vragen entiteiten waar wij tekst hebben; hiervoor hoeven we niets te
 * verzinnen. Een library is precies wat er al staat: onze open tracks, met een
 * echte telling en een echt id.
 *
 * WAAROM HET NODIG IS, gemeten op 13-8. open.audio heeft onze vier tracks
 * binnengehaald langs de AP-weg -- met ONZE track-id's, en met een artist_credit
 * dat Funkwhale zelf uit onze attributedTo afleidde. Maar `uploads` is leeg en
 * `is_playable` false. Bij hen hangt een upload aan een library; zonder library
 * is er geen bak om het bestand in te hangen. Het audiobestand zelf is wel
 * gewoon op te halen (200, audio/mpeg, ook anoniem) -- ze hebben het niet
 * geprobeerd.
 *
 * SKELET, en dat woord is letterlijk bedoeld. Dit is de vorm uit hun docs:
 * type, id, name, followers, totalItems, first, last, plus attributedTo en
 * summary. Wat er NIET is: de volg-afhandeling. Onze bibliotheek is openbaar --
 * elke track erin heeft fedi_open -- dus er valt niets goed te keuren. Komt er
 * ooit een besloten variant, dan hoort daar het Follow/Accept-werk bij.
 */
export function buildLibrary(base, site, rows, { page = false } = {}) {
  const id = libraryId(base, site);
  const hostPosts = site.id ? trackHostPosts(site.id) : null;
  const albums = site.id ? trackAlbums(site.id) : null;
  const items = (rows || []).map((r) => buildTrackAudio(base, site, r, { hostPosts, albums }));
  return pagedCollection(id, items, {
    page,
    // Een platenkast is geen tijdlijn: `Collection`, niet `OrderedCollection`.
    // Funkwhale's LibrarySerializer accepteert ook alleen die twee typen
    // (as:Collection of fw:Library) en zijn CollectionPageSerializer alleen
    // `CollectionPage` met `items`.
    ongeordend: true,
    extra: {
      type: 'Library',
      name: site.title || site.slug,
      attributedTo: actorId(base, site.slug),
      // WAAROM DIT VELD ER MOET STAAN. Funkwhale's LibrarySerializer noemt
      // `audience` optioneel, maar zijn create() doet er meteen
      // `privacy[validated_data["audience"]]` mee -- zonder de sleutel is dat
      // een KeyError en geeft hun server een 500. Dat is wat open.audio op 15-8
      // teruggaf toen Robin onze library-URI daar opzocht.
      //
      // Het is bovendien gewoon waar: alles hierin is fedi_open, dus openbaar.
      // Bij hen is dit precies het verschil tussen privacy_level 'everyone' en
      // 'me' -- oftewel of onze nummers daar afspeelbaar zijn.
      audience: 'https://www.w3.org/ns/activitystreams#Public',
      // Vereist volgens hun docs. Openbaar, dus de telling is eerlijk en de
      // lijst blijft leeg -- wie ons volgt volgt de ACTOR, niet de bak.
      followers: `${id}/followers`,
      ...(site.description ? { summary: String(site.description).slice(0, 500) } : {}),
    },
  });
}

/** De collectie van alle open tracks van een site (shaer-0nh, stap 3). */
export function buildTrackCollection(base, site, rows, { page = false } = {}) {
  // Eén zoekopdracht voor alle rijen samen; zie trackHostPosts.
  const posts = site.id ? trackHostPosts(site.id) : null;
  const albums = site.id ? trackAlbums(site.id) : null;
  const items = (rows || []).map((r) => buildTrackAudio(base, site, r, { hostPosts: posts, albums }));
  return pagedCollection(`${actorId(base, site.slug)}/tracks`, items, { page, extra: { attributedTo: actorId(base, site.slug) } });
}

// Een post die een playlist insluit wijst in zijn AS2 ook naar de collectie
// (shaer-ayc, stap 2): een Link-tag per ingesloten playlist. Mastodon
// parseert alleen Mention/Hashtag/Emoji en negeert een Link geruisloos; een
// client die hem kent haalt de collectie op. Opgelost uit post.content en
// ALLEEN binnen de eigen site: playlist-ids zijn een globale primary key, dus
// zonder site-check zou een post van site A naar de collectie van site B
// kunnen wijzen.
export function playlistLinkTags(base, site, content, post = null) {
  const out = [];
  try {
    // Zelfde patroon als de renderer en als de afleiding: wat niet insluit,
    // krijgt ook geen link. Dit stond hier met een eigen patroon dat
    // underscores accepteerde die nergens anders meetellen.
    for (const id of ingeslotenPlaylists(content)) {
      const pl = db.prepare('SELECT id, title FROM playlists WHERE id = ? AND site_id = ?').get(id, site.id);
      if (!pl) continue;
      out.push({ type: 'Link', href: `${actorId(base, site.slug)}/playlists/${pl.id}`, mediaType: 'application/activity+json', name: pl.title });
    }
    // Losse tracks in een post zijn ook een uitgave (shaer-38y): ze krijgen een
    // eigen collectie, en de post wijst er langs dezelfde weg naar. Zonder deze
    // link zou die collectie bestaan maar door niemand te vinden zijn.
    if (post && post.id) {
      const eenheid = postMusicType(content, site.id);
      if (eenheid && !eenheid.collectie && eenheid.tracks?.length && losseTracksVanPost(site.id, eenheid.tracks).length) {
        out.push({
          type: 'Link',
          href: postTracksId(base, site, post.id),
          mediaType: 'application/activity+json',
          name: post.title || 'Tracks',
        });
      }
    }
  } catch { /* niet-fataal: een tag minder, geen kapotte Note */ }
  return out;
}

// De lijst van alle playlist-collecties van een site (shaer-ayc, stap 2).
// Kaal standaard (URI's), verrijkt op verzoek (FEP-9876, zelfde conventie als
// followers/following): een stub per playlist met naam, hoes en de EERLIJKE
// telling -- totalItems van de stub telt het open deel, dezelfde regel als de
// collectie zelf, want ook een lijst mag niet verklappen wat er achter de
// poort staat.
export function listPlaylistsAP(base, site, enriched, { page = false } = {}) {
  const rows = db.prepare(
    'SELECT id, title, artist, year, cover_url FROM playlists WHERE site_id = ? ORDER BY created_at, id'
  ).all(site.id);
  const colId = `${actorId(base, site.slug)}/playlists`;
  const items = rows.map((p) => {
    const uri = `${actorId(base, site.slug)}/playlists/${p.id}`;
    if (!enriched) return uri;
    const stub = buildPlaylistCollection(base, site, p, playlistOpenTracks(p.id));
    delete stub['@context'];       // genest object draagt de context van zijn omhulsel
    delete stub.orderedItems;      // stub: wie de tracks wil, haalt de collectie op
    return stub;
  });
  return pagedCollection(colId, items, { page, extra: { attributedTo: actorId(base, site.slug) } });
}

/**
 * Bij welke UITGAVE hoort een track? (shaer-756s, stap 2)
 *
 * Alleen playlists met kind='album' tellen: een mixtape is geen uitgave, en dat
 * onderscheid is precies wat de keuze album/playlist betekent. Zit een track in
 * twee albums, dan wint de oudste -- willekeurig maar STABIEL, en dat is wat
 * telt: een id dat per ophaalactie verspringt is erger dan een id dat niet de
 * mooiste keuze is.
 *
 * Eén zoekopdracht voor alle rijen samen, zoals trackHostPosts. Per track
 * vragen wordt bij tweehonderd nummers tweehonderd zoekopdrachten.
 */
export function trackAlbums(siteId) {
  const rijen = db.prepare(`
    SELECT pt.track_id AS tid, p.id, p.title, p.artist, p.year, p.cover_url,
           p.release_date, p.mb_release_id, p.created_at
      FROM playlist_tracks pt
      JOIN playlists p ON p.id = pt.playlist_id
     WHERE p.site_id = ? AND p.kind = 'album'
     ORDER BY p.created_at, p.id
  `).all(siteId);
  const uit = new Map();
  for (const r of rijen) if (!uit.has(r.tid)) uit.set(r.tid, r);
  return uit;
}

/**
 * Een uitgave als `fw:Album`.
 *
 * INGESLOTEN EN NIET ALS URI, en dat is het hele punt van deze stap. Funkwhale's
 * TrackSerializer heeft `album = AlbumSerializer()` -- een object met name,
 * published en een eigen artist_credit. Een kale URI expandeert naar een knoop
 * met alleen een @id en valt daar dus af. Emissary stuurt precies zo'n kale URI,
 * en dat is waarom hun tracks bij Funkwhale net zo goed stranden.
 *
 * Het `id` is de bestaande playlist-collectie: dereferenceerbaar, en het is
 * werkelijk hetzelfde ding. We verzinnen geen tweede adres voor iets dat er al
 * een heeft.
 */
export function buildAlbumObject(base, site, pl) {
  if (!pl) return null;
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
  const wanneer = pl.created_at ? new Date(pl.created_at).toISOString() : new Date(0).toISOString();
  const album = {
    type: 'Album',
    id: `${actorId(base, site.slug)}/playlists/${pl.id}`,
    name: pl.title,
    published: wanneer,
    attributedTo: actorId(base, site.slug),
    artist_credit: artistCredit(base, site, pl.artist, wanneer),
  };
  // `released` alleen als er een ECHTE datum is. `year` vult hem niet aan: een
  // jaartal is geen dag, en dat is de reden dat release_date bestaat.
  if (pl.release_date) album.released = pl.release_date;
  if (pl.mb_release_id) album.musicbrainzId = pl.mb_release_id;
  const hoes = abs(pl.cover_url || null);
  if (hoes) album.image = { type: 'Image', mediaType: guessMediaType(hoes), url: hoes };
  return album;
}

export function buildPlaylistCollection(base, site, playlist, rows) {
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
  // Dezelfde objecten als in de actor-collectie, met hetzelfde id (shaer-0nh,
  // stap 3). Een playlist is een KEUZE uit wat de artiest heeft uitgebracht,
  // geen tweede exemplaar ervan: staat een track in twee playlists, dan is het
  // twee keer hetzelfde ding en niet twee dingen die toevallig gelijk klinken.
  // De hoes van de playlist dient als terugval voor een track zonder eigen hoes.
  const hostPosts = site.id ? trackHostPosts(site.id) : null;
  const albums = site.id ? trackAlbums(site.id) : null;
  const items = (rows || []).map((r) => buildTrackAudio(base, site, r, { coverFallback: playlist.cover_url || null, hostPosts, albums }));
  const out = pagedCollection(`${actorId(base, site.slug)}/playlists/${playlist.id}`, items, {
    extra: { name: playlist.title, attributedTo: actorId(base, site.slug) },
  });
  // Album of playlist is presentatie; op de draad is het één samenvattingsveld.
  const parts = [];
  if (playlist.artist) parts.push(playlist.artist);
  if (playlist.year) parts.push(String(playlist.year));
  if (parts.length) out.summary = parts.join(' · ');
  const cover = abs(playlist.cover_url || null);
  if (cover) out.icon = { type: 'Image', mediaType: guessMediaType(cover), url: cover };

  // Is dit een UITGAVE, dan draagt deze collectie ook de albumvelden
  // (shaer-756s, stap 2): het is het adres waar track.album naar wijst, en dan
  // hoort hier hetzelfde te staan als in het ingesloten object.
  //
  // `type` blijft OrderedCollection, EN BLIJFT EEN STRING. Er stond hier even
  // ['OrderedCollection', 'Album'] -- geldig AS2, en het is ook werkelijk
  // allebei -- maar een bestaande test viel erover, en die test had gelijk: een
  // lezer die `type` als tekst uitpakt (Shaer doet dat) verliest dan in stilte
  // de hele playlist. Het kost ons niets, want hun AlbumSerializer declareert
  // geen type-veld en valideert het dus niet: haalt Funkwhale dit adres op als
  // album, dan leest hij deze velden gewoon. En het object dat hij echt gebruikt
  // staat toch al ingesloten op de track.
  if ((playlist.kind || 'album') === 'album') {
    const album = buildAlbumObject(base, site, playlist);
    for (const veld of ['published', 'released', 'musicbrainzId', 'artist_credit', 'image']) {
      if (album[veld] !== undefined) out[veld] = album[veld];
    }
  }
  return leenVanPost(base, site, out, uitgavePost(site.id, playlist.id));
}

// ── De post als uitgave (shaer-38y) ───────────────────────────────────────

/** Het AS2-id van de collectie losse tracks van een post. */
function postTracksId(base, site, postId) {
  return `${actorId(base, site.slug)}/posts/${encodeURIComponent(postId)}/tracks`;
}

/**
 * Welke post brengt deze playlist uit, en mag die zijn gegevens uitlenen?
 *
 * Niet zomaar de eerste post die de playlist noemt: alleen een post die er EEN
 * muzikale eenheid van maakt leent uit. Staan er twee collecties in, dan is de
 * post niet meer de drager van een identiteit en houdt de playlist de zijne --
 * dezelfde regel als in de afleiding, hier alleen toegepast.
 *
 * De nieuwste wint als er meerdere zijn: dat is waar hij het laatst is
 * uitgebracht.
 */
export function uitgavePost(siteId, playlistId) {
  if (!siteId || !playlistId) return null;
  try {
    const rijen = db.prepare(`
      SELECT id, slug, title, excerpt, content, cover_image_url, tags
      FROM posts
      WHERE site_id = ? AND status = 'published'
        AND content LIKE '%[[playlist:' || ? || ']]%'
      ORDER BY COALESCE(published_at, created_at) DESC
    `).all(siteId, playlistId);
    for (const p of rijen) {
      const r = postMusicType(p.content, siteId);
      if (r && r.leentMetadata && r.collectie && r.collectie.id === playlistId) return p;
    }
  } catch { /* geen lening is geen fout */ }
  return null;
}

/**
 * De post leent zijn gegevens aan de uitgave (shaer-38y, punt 3).
 *
 * WAAROM DE POST WINT EN NIET DE PLAYLIST. Een playlist heeft een titel en soms
 * een hoes; een post heeft een titel, een tekst, een hoes, tags EN een datum.
 * Voor audio-gebaseerde inhoud is de post de uitgave -- dat is waar iemand hem
 * heeft uitgebracht en waar het verhaal erbij staat. Een Funkwhale-achtige
 * lezer vindt een collectie met alleen een naam te mager, en dat is precies wat
 * hij nu krijgt.
 *
 * De naam van de playlist gaat niet verloren: die blijft als `alsoKnownAs`
 * staan, zodat de eigen naam terug te vinden is als hij afwijkt.
 */
function leenVanPost(base, site, obj, post) {
  if (!post) return obj;
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);

  if (post.title) {
    if (obj.name && obj.name !== post.title) obj.alsoKnownAs = obj.name;
    obj.name = post.title;
  }
  // De tekst als `content`, niet als `summary`: in AS2 is summary de korte
  // samenvatting en content het lijf. Artiest en jaar blijven dus in summary
  // staan -- dat is een samenvatting, en de posttekst is dat niet.
  const tekst = tekstVanPost(post);
  if (tekst) obj.content = tekst;

  const cover = abs(post.cover_image_url || null);
  if (cover) {
    obj.image = { type: 'Image', mediaType: guessMediaType(cover), url: cover };
    if (!obj.icon) obj.icon = obj.image;      // geen eigen hoes? dan die van de post
  }

  // Dezelfde lijst als de Note: het tagveld EN de hashtags uit het lijf, waarbij
  // de geschreven vorm voorgaat. Een eigen lijst hier zou de tags uit de tekst
  // missen en de rest anders spellen dan dezelfde post elders doet.
  const tags = buildHashtagList(base, post.tags, post.content, { ruw: true });
  if (tags.length) obj.tag = tags;

  // Waar je hem kunt horen, en waar hij bij hoort. Zelfde paar als bij een
  // losse track: url wijst een mens naar de post, context zegt waar dit object
  // thuishoort.
  obj.url = `${base}/${post.slug}`;
  obj.context = noteId(base, post.id);
  return obj;
}

/**
 * De tekst van een post, als er een is. De excerpt heeft voorrang -- die is
 * geschreven om samen te vatten. Staat die leeg, dan het lijf zelf: zonder
 * shortcodes (die zijn de muziek, niet het verhaal erover) en zonder opmaak.
 * Levert null als er niets overblijft, want een leeg veld is slechter dan geen.
 */
function tekstVanPost(post) {
  const excerpt = String(post.excerpt || '').trim();
  if (excerpt) return excerpt;
  const kaal = String(post.content || '')
    .replace(/\[\[[a-z]+:[^\]]*\]\]/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    // Losse hashtags gaan eruit: die staan al in `tag`, en een description die
    // de tagwolk herhaalt is ruis. Live leverde dit "#DoenweNiet #DoenWeNiet
    // #devs" op als omschrijving van een post die verder geen tekst heeft.
    .replace(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return kaal || null;
}

/** De open tracks uit een lijst ids, in de volgorde van die lijst. */
function losseTracksVanPost(siteId, ids) {
  if (!siteId || !ids?.length) return [];
  const gaten = ids.map(() => '?').join(',');
  const rijen = db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
     FROM audio_tracks t JOIN media m ON m.id = t.media_id
     WHERE t.site_id = ? AND t.fedi_open = 1 AND t.id IN (${gaten})`
  ).all(siteId, ...ids);
  // De volgorde van de POST, niet die van de tabel (shaer-38y, punt 1): zoals
  // iemand ze heeft neergezet is de volgorde waarin ze bedoeld zijn.
  const opId = new Map(rijen.map((r) => [r.id, r]));
  return ids.map((id) => opId.get(id)).filter(Boolean);
}

/**
 * De losse tracks van een post als EEN uitgave (shaer-38y).
 *
 * Tot nu toe gingen die los de deur uit: losse Audio-objecten die een lezer
 * nergens kon plaatsen. Ze horen bij elkaar omdat ze in dezelfde post staan, en
 * dat is wat deze collectie zegt -- met de gegevens van de post erbij, want die
 * heeft ze wel en de losse tracks niet.
 *
 * Geeft null als er niets te tonen is: geen post, geen losse tracks, of een
 * post die geen enkele muzikale eenheid IS.
 */
export function buildPostTrackCollection(base, site, post) {
  if (!post || !post.id) return null;
  const eenheid = postMusicType(post.content, site.id);
  if (!eenheid || eenheid.collectie || !eenheid.tracks?.length) return null;

  const rows = losseTracksVanPost(site.id, eenheid.tracks);
  if (!rows.length) return null;

  const hostPosts = new Map(rows.map((r) => [r.id, { id: post.id, slug: post.slug }]));
  const out = pagedCollection(postTracksId(base, site, post.id),
    rows.map((r) => buildTrackAudio(base, site, r, { hostPosts })),
    { extra: { attributedTo: actorId(base, site.slug) } });
  return leenVanPost(base, site, out, post);
}

/**
 * Een track als publicatie: Create(Audio) (shaer-0nh, stap 4).
 *
 * Zelfde vorm als buildCreate voor een post, met een STABIEL id: dezelfde track
 * levert altijd dezelfde activiteit, zodat een lezer die de outbox twee keer
 * ophaalt niet denkt dat er iets nieuws is.
 */
export function buildTrackCreate(base, site, r, opts = {}) {
  const audio = buildTrackAudio(base, site, r, opts);
  const me = actorId(base, site.slug);
  return {
    '@context': AP_CONTEXT,
    id: `${audio.id}#create`,
    type: 'Create',
    actor: me,
    published: audio.published,
    to: [PUBLIC],
    cc: [`${me}/followers`],
    object: audio,
  };
}

/**
 * `category` is kanaal-vocabulaire, en de waarde is 'music' (Robins keuze, 7-8).
 * Alleen gezet als de site ECHT audio publiceert: een blog zonder muziek als
 * muziekkanaal aankondigen is erger dan geen label. Het signaal is een track in
 * de kast, niet enable_audio_player -- die staat standaard aan en zegt niets.
 */
export function channelCategory(site) {
  try {
    // ALLEEN opengezette tracks tellen. Eerst keek dit naar elke track, ook een
    // gated -- en dan roept een site met uitsluitend afgeschermde muziek toch
    // "hier is muziek" naar de hele fediverse. Dat botst met de regel die we
    // overal aanhouden: een gesloten track is AFWEZIG, niet stilletjes
    // aanwezig. Naar buiten toe is een kanaal zonder publieke muziek geen
    // muziekkanaal.
    return db.prepare('SELECT 1 FROM audio_tracks WHERE site_id = ? AND fedi_open = 1 LIMIT 1').get(site.id) ? 'music' : null;
  } catch { return null; }
}

// ── Welk soort muzikale uitgave is deze post? (shaer-cyg) ─────────────

/**
 * Het type van een post afleiden uit de muziek die erin staat.
 *
 * DE REGEL ZELF staat in assets/js/shared/post-music-type.js, want de editor
 * gebruikt hem ook -- daar volgt het type live mee terwijl je schrijft. Twee
 * kopieen zouden stil uit elkaar lopen, dus is er er een. Hier komt alleen het
 * stuk bij dat de server kan en de browser niet: de gekozen soort van een
 * playlist opzoeken.
 *
 * WAARVOOR DIT WEL EN NIET IS (Robins afbakening, 9-8). Nieuwe posts krijgen
 * hun type uit de keuze: album of playlist wordt gekozen als de playlist wordt
 * gemaakt, en de post neemt dat over. Op de server is dit vooral voor wat er al
 * staat -- de posts met type=audio uit de tijd voor die keuze bestond.
 *
 * @param {string} content   de HTML/tekst van de post
 * @param {string} siteId    nodig om playlists.kind te kunnen opzoeken
 */
export function postMusicType(content, siteId) {
  return afleidenUitInsluitingen(content, (id) => playlistKind(id, siteId));
}

/**
 * De gekozen soort van een playlist: 'album' | 'playlist', of null als hij niet
 * (op deze site) bestaat. Zelfde normalisatie als PlaylistService: alles wat
 * geen 'playlist' zegt is een album.
 */
function playlistKind(id, siteId) {
  if (!siteId) return null;
  try {
    const r = db.prepare('SELECT kind FROM playlists WHERE id = ? AND site_id = ?').get(id, siteId);
    if (!r) return null;
    return r.kind === 'playlist' ? 'playlist' : 'album';
  } catch { return null; }
}
