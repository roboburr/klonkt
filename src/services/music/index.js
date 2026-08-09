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
import { AP_CONTEXT, PUBLIC, actorId, noteId, safeUrl, guessMediaType } from '../ap-core.js';

// m.size hoort erbij voor de RSS-enclosure: die eist een lengte in bytes.
const TRACK_KOLOMMEN = `t.id, t.title, t.artist, t.duration, t.cover_url, t.created_at,
     t.position, t.license,
     m.filename, m.storage_path, m.mime_type, m.size`;

export function playlistOpenTracks(playlistId) {
  return db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
     FROM playlist_tracks pt
     JOIN audio_tracks t ON t.id = pt.track_id
     JOIN media m ON m.id = t.media_id
     WHERE pt.playlist_id = ? AND t.fedi_open = 1
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
export function siteOpenTracks(siteId) {
  return db.prepare(
    `SELECT ${TRACK_KOLOMMEN}
     FROM audio_tracks t JOIN media m ON m.id = t.media_id
     WHERE t.site_id = ? AND t.fedi_open = 1
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
  if (r.artist) a.summary = r.artist;              // artiest als summary: kaal AS2, geen eigen vocab
  // AS2-kern `context`: "de context waarbinnen dit object bestaat". Voor een
  // track is dat de post die hem uitbrengt. Daarmee is de relatie die tot nu
  // toe alleen in posts.content stond, op de draad te zien -- en kan een lezer
  // die de post al heeft dit nummer overslaan in plaats van er een lege kaart
  // van te maken.
  if (post) a.context = noteId(base, post.id);
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

/** De collectie van alle open tracks van een site (shaer-0nh, stap 3). */
export function buildTrackCollection(base, site, rows) {
  return {
    '@context': AP_CONTEXT,
    id: `${actorId(base, site.slug)}/tracks`,
    type: 'OrderedCollection',
    attributedTo: actorId(base, site.slug),
    totalItems: (rows || []).length,
    // Eén zoekopdracht voor alle rijen samen; zie trackHostPosts.
    orderedItems: (() => {
      const posts = site.id ? trackHostPosts(site.id) : null;
      return (rows || []).map((r) => buildTrackAudio(base, site, r, { hostPosts: posts }));
    })(),
  };
}

// Een post die een playlist insluit wijst in zijn AS2 ook naar de collectie
// (shaer-ayc, stap 2): een Link-tag per ingesloten playlist. Mastodon
// parseert alleen Mention/Hashtag/Emoji en negeert een Link geruisloos; een
// client die hem kent haalt de collectie op. Opgelost uit post.content en
// ALLEEN binnen de eigen site: playlist-ids zijn een globale primary key, dus
// zonder site-check zou een post van site A naar de collectie van site B
// kunnen wijzen.
export function playlistLinkTags(base, site, content) {
  const out = [];
  const seen = new Set();
  try {
    for (const m of (content || '').matchAll(/\[\[playlist:([A-Za-z0-9_-]+)\]\]/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      const pl = db.prepare('SELECT id, title FROM playlists WHERE id = ? AND site_id = ?').get(m[1], site.id);
      if (!pl) continue;
      out.push({ type: 'Link', href: `${actorId(base, site.slug)}/playlists/${pl.id}`, mediaType: 'application/activity+json', name: pl.title });
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
export function listPlaylistsAP(base, site, enriched) {
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
  return {
    '@context': AP_CONTEXT,
    id: colId,
    type: 'OrderedCollection',
    attributedTo: actorId(base, site.slug),
    totalItems: items.length,
    orderedItems: items,
  };
}

export function buildPlaylistCollection(base, site, playlist, rows) {
  const abs = (u) => !u ? null : (/^https?:/i.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`);
  // Dezelfde objecten als in de actor-collectie, met hetzelfde id (shaer-0nh,
  // stap 3). Een playlist is een KEUZE uit wat de artiest heeft uitgebracht,
  // geen tweede exemplaar ervan: staat een track in twee playlists, dan is het
  // twee keer hetzelfde ding en niet twee dingen die toevallig gelijk klinken.
  // De hoes van de playlist dient als terugval voor een track zonder eigen hoes.
  const hostPosts = site.id ? trackHostPosts(site.id) : null;
  const items = (rows || []).map((r) => buildTrackAudio(base, site, r, { coverFallback: playlist.cover_url || null, hostPosts }));
  const out = {
    '@context': AP_CONTEXT,
    id: `${actorId(base, site.slug)}/playlists/${playlist.id}`,
    type: 'OrderedCollection',
    name: playlist.title,
    attributedTo: actorId(base, site.slug),
    totalItems: items.length,
    orderedItems: items,
  };
  // Album of playlist is presentatie; op de draad is het één samenvattingsveld.
  const parts = [];
  if (playlist.artist) parts.push(playlist.artist);
  if (playlist.year) parts.push(String(playlist.year));
  if (parts.length) out.summary = parts.join(' · ');
  const cover = abs(playlist.cover_url || null);
  if (cover) out.icon = { type: 'Image', mediaType: guessMediaType(cover), url: cover };
  return out;
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

// ── Welk soort muzikale uitgave is deze post? (shaer-cyg) ─────────────────

/**
 * Het type van een BESTAANDE post afleiden uit de muziek die erin staat.
 *
 * WAARVOOR DIT WEL EN NIET IS (Robins afbakening, 9-8). Nieuwe posts krijgen
 * hun type uit de keuze: album of playlist wordt gekozen als de playlist wordt
 * gemaakt, en de post neemt dat over. Deze functie is er voor wat er al staat --
 * de posts met type=audio uit de tijd voor die keuze bestond. Daarmee is de
 * vraag "wie wint, de keuze of de afleiding?" geen vraag meer: ze komen elkaar
 * niet tegen. De afleiding draait eenmalig, de keuze draait daarna.
 *
 * DE REGEL GAAT OVER IDENTITEIT, NIET OVER TELLEN (Robins herformulering, 9-8):
 * een post neemt het type van zijn muziek over als hij precies EEN muzikale
 * eenheid bevat. Zijn het er meer, dan is de post een post die naar muziek
 * verwijst, en houden de collecties hun eigen identiteit.
 *
 *   losse track(s)                -> playlist   metadata van de post geleend
 *   een collectie                 -> die soort  metadata van de post geleend
 *   een collectie + losse tracks  -> album      de losse zijn BONUS-TRACKS
 *   twee of meer collecties       -> post       NIETS geleend
 *
 * Waarom de lening bij de laatste vervalt: die bestaat omdat een collectie soms
 * dun is -- geen eigen hoes, geen eigen titel. Bij twee is de post niet meer de
 * drager van EEN identiteit, en vervalt de reden vanzelf. Dezelfde regel zet
 * zichzelf uit.
 *
 * EEN COLLECTIE IS EEN PLAYLIST OF EEN ALBUM-INSLUITING. Robins regel noemde
 * alleen playlists, maar [[album:naam]] groepeert net zo goed tracks en is
 * letterlijk een album; hem als losse tracks tellen zou een albumpost tot
 * playlist maken. Telt hij straks anders, dan is dat hier een regel.
 *
 * WIE KIEST ALBUM OF PLAYLIST: dat gebeurt wanneer de PLAYLIST wordt gemaakt,
 * en die keuze staat al in playlists.kind. Bij een enkele insluiting neemt de
 * post dus die soort over -- een post om een album is een album, ook al heet de
 * shortcode [[playlist:...]]. De soort van een playlist wordt hier dus
 * OPGEZOCHT en niet afgeleid.
 *
 * EN ALS WE HET NIET WETEN: een gewone post met insluitingen die de post als
 * context hebben. Dat is geen noodgreep maar de rustende toestand -- tracks
 * wijzen met `context` toch al terug naar hun post, dus er gaat niets verloren
 * als het label 'post' wordt.
 *
 * @param {string} content   de HTML/tekst van de post
 * @param {string} siteId    nodig om playlists.kind te kunnen opzoeken
 */
export function postMusicType(content, siteId) {
  const c = String(content || '');
  const uniek = (re) => [...new Set([...c.matchAll(re)].map((m) => m[1].trim()))];

  // Dezelfde patronen als de renderer in AudioEmbedService: wat daar niet
  // insluit, telt hier niet mee. Anders zou een shortcode die niets oplevert
  // wel het type van de post kunnen bepalen.
  const playlists = uniek(/\[\[playlist:([a-z0-9][a-z0-9-]*)\]\]/gi);
  const albums    = uniek(/\[\[album:([^\]]+)\]\]/g);
  const tracks    = uniek(/\[\[track:([A-Za-z0-9_-]+)\]\]/g);

  if (!playlists.length && !albums.length && !tracks.length) return null;

  // De soort van een playlist is een gegeven, geen afleiding.
  let onbekend = [];
  const uitPlaylists = playlists.map((id) => {
    const kind = playlistKind(id, siteId);
    if (!kind) { onbekend.push(id); return null; }
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
    // Losse tracks naast een collectie zijn geen rommelrestje maar bonus-tracks,
    // en dat maakt het geheel een album.
    if (tracks.length) return { type: 'album', collectie: c0, tracks: [], bonus: tracks, leentMetadata: true };
    return { type: c0.soort, collectie: c0, tracks: [], bonus: [], leentMetadata: true };
  }

  return { type: 'post', collecties, tracks, bonus: [], leentMetadata: false };
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
