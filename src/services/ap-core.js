/**
 * De primitieven die iedereen die ActivityPub uitzendt nodig heeft.
 *
 * Waarom dit bestand er is (shaer-drc): ActivityPubService.js was 6436 regels
 * met 166 exports en tweeentwintig secties. Een submap zoals music/ kan pas
 * zelfstandig bestaan als deze zes dingen ergens staan waar BEIDE uit kunnen
 * putten -- anders importeert de submap uit ActivityPubService en importeert
 * die weer terug, en dat is een kring.
 *
 * Guardianship laat zien hoe het wel moet: die map importeert alleen db en zijn
 * eigen buren, nooit terug. Dit bestand maakt datzelfde mogelijk voor de rest.
 *
 * Alles hier is PUUR: geen database, geen netwerk, geen toestand. Dat is de
 * grens -- komt daar iets bij dat wel iets weet, dan hoort het hier niet.
 *
 * EEN UITZONDERING OP "PUUR": AP_CONTEXT stelt zichzelf samen uit
 * Guardianship.SHAER_CONTEXT. Die context is nu eenmaal de optelsom van ieders
 * termen, dus dat hoort zo. Het maakt geen kring: guardianship kent alleen db
 * en zijn eigen buren en importeert nooit terug.
 */

import * as Guardianship from './guardianship/index.js';

export const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';
// Full JSON-LD context for every AP object we emit: AS2 core + security (publicKey) + the
// extension terms we actually use (Mastodon/toot + schema.org), each with a term definition
// so a strict JSON-LD processor resolves them instead of dropping them → valid AS2/JSON-LD.
// This is the same context shape Mastodon publishes, so Mastodon sees no change.
export const AP_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://w3id.org/security/v1',
  {
    toot: 'http://joinmastodon.org/ns#',
    schema: 'http://schema.org#',
    sensitive: 'as:sensitive',
    Hashtag: 'as:Hashtag',
    manuallyApprovesFollowers: 'as:manuallyApprovesFollowers',
    discoverable: 'toot:discoverable',
    // FEP-7628 (account moves): same term declaration Mastodon ships.
    alsoKnownAs: { '@id': 'as:alsoKnownAs', '@type': '@id' },
    movedTo: { '@id': 'as:movedTo', '@type': '@id' },
    featured: { '@id': 'toot:featured', '@type': '@id' },
    PropertyValue: 'schema:PropertyValue',
    value: 'schema:value',
    embedUrl: { '@id': 'schema:embedUrl', '@type': '@id' },
    // Wat een track beschrijft en AS2 niet kent (shaer-0nh). Funkwhale zet deze
    // vier op zijn Audio; het bleken geen eigen verzinsels maar termen die
    // schema.org gewoon heeft -- en schema.org stond hier al. De SLEUTELS zijn
    // die van Funkwhale, want daar leest hij op; de BETEKENIS komt van
    // schema.org, dus we hoeven geen vreemd vocabulaire binnen te halen.
    license: { '@id': 'schema:license', '@type': '@id' },
    // "Dit ding is ook bekend onder die URI" -- voor de MusicBrainz-koppeling
    // van een artiest (shaer-mbz). Bewust NIET alsoKnownAs: dat is in AS2
    // gereserveerd voor vroegere IDENTITEITEN van dezelfde actor, en een
    // verhuizing leunt erop (FEP-7628). Een verwijzing naar een register is
    // iets anders dan een oud account van jezelf, en die twee door elkaar halen
    // zou een verhuizing kunnen laten mislukken.
    sameAs: { '@id': 'schema:sameAs', '@type': '@id' },
    // ── Wat we uit Funkwhale's vocabulaire overnemen, en waarom ──
    //
    // LIBRARY. Gemeten op 13-8: open.audio had onze vier tracks binnengehaald
    // via hun AP-id, met een artist_credit dat het zelf uit onze attributedTo
    // afleidde -- maar uploads LEEG en is_playable false. Bij Funkwhale hangt
    // een upload aan een library; zonder die bak blijft een track een naam
    // zonder geluid.
    //
    // TRACK. Hier stond dat we deze NIET namen, met als reden: hij vraagt een
    // entiteit waar wij tekst hebben, en er een id voor verzinnen belooft wat
    // we niet waarmaken. Die redenering klopte half, en de Emissary-meting van
    // 16-8 (shaer-3f8a) laat zien welke helft. Een TRACK heeft bij ons wel
    // degelijk een eigen identiteit -- het is een rij met een titel en een
    // plaats in een uitgave. Wat wij niet hebben is een ALBUM als entiteit, en
    // dat is een andere vraag (shaer-k37k). Emissary stuurt precies die kleine
    // vorm: type, id, name, position. Wij ook, en album blijft eruit tot het
    // een echt object is -- een verzonnen album-URI is nu juist wel de belofte
    // die we niet kunnen waarmaken.
    //
    // Twee onafhankelijke implementaties zenden dit nu, en het is de kant waar
    // FEP-be68 heen beweegt. ArtistCredit blijft eruit: dat is nog steeds een
    // entiteit die wij niet hebben.
    //
    // De vorm van de termen is letterlijk die van hun contexts.py (regel
    // 293-306), zodat een lezer die hun context laadt en een lezer die de onze
    // leest op dezelfde IRI's uitkomen.
    fw: 'https://funkwhale.audio/ns#',
    Library: 'fw:Library',
    library: { '@id': 'fw:library', '@type': '@id' },
    Track: 'fw:Track',
    track: { '@id': 'fw:track', '@type': '@id' },
    // ARTIEST-CREDIT. Hun TrackSerializer eist minstens een artist_credit, en
    // dat leek lang onmogelijk: het vraagt een Artist met een eigen id, en bij
    // ons was een artiest tekst. Sinds de MusicBrainz-koppeling (shaer-mbz) is
    // dat niet meer waar -- de site-ACTOR is de artiest. Een echte, opvraagbare
    // URI, met de sitetitel als naam en een musicbrainzId als hij gekoppeld is.
    // Er valt hier niets te verzinnen; open.audio leidde dit zelfs al zelf af
    // uit onze attributedTo (gemeten 13-8).
    //
    // `@container: @list` is GEEN opsmuk. Ze lezen dit veld met
    // first_attr(FW.artist_credit, "@list"), en zonder die declaratie expandeert
    // onze array niet naar een @list -- dan staat er iets dat er goed uitziet en
    // door hun lezer niet gevonden wordt. Letterlijk hun contexts.py regel 311.
    Artist: 'fw:Artist',
    ArtistCredit: 'fw:ArtistCredit',
    artist: { '@id': 'fw:artist', '@type': '@id' },
    artist_credit: { '@id': 'fw:artist_credit', '@type': '@id', '@container': '@list' },
    credit: 'fw:credit',
    musicbrainzId: 'fw:musicbrainzId',
    position: 'schema:position',
    bitrate: 'schema:bitrate',
    size: 'schema:contentSize',
    // Poll (Question) extension: Question/oneOf/anyOf/endTime/closed are AS2 core, but the
    // per-poll unique-voter count is a Mastodon (toot) term — declare it so the emitted
    // Question stays valid JSON-LD (a strict processor would otherwise drop votersCount).
    votersCount: 'toot:votersCount',
    // FEP-1580 (objectmigratie bij een Move). FEP-7628 verhuist je VOLGERS en
    // zegt dat zelf met zoveel woorden: de objecten zijn een ander probleem, en
    // dit is de FEP waar dat geregeld wordt. De namespace is die van de FEP zelf
    // (aangemeld via FEP-888d). De CURIE van de collectie is `migration:migration`,
    // door de auteur zelf "maybe unhelpfully" genoemd; wij emitteren de JSON-sleutel
    // `migration`, want daar leest een consument op.
    migration: { '@id': 'https://w3id.org/fep/1580/migration', '@type': '@id' },
    moves: { '@id': 'https://w3id.org/fep/1580/moves', '@type': '@id' },
    migrationComplete: 'https://w3id.org/fep/1580/migrationComplete',
    migratedFrom: { '@id': 'https://w3id.org/fep/1580/migratedFrom', '@type': '@id' },
    migratedAt: 'https://w3id.org/fep/1580/migratedAt',
    // Kanaal-vocabulaire (shaer-0nh). Funkwhale declareert `category` niet
    // inline maar via zijn eigen remote context https://funkwhale.audio/ns, en
    // die host is vanaf hier onbereikbaar -- de IRI hieronder is dus AFGELEID
    // en niet geverifieerd. Wat vandaag telt voor interop is de JSON-sleutel,
    // want daar matchen lezers op; de declaratie zorgt alleen dat een strikte
    // JSON-LD-processor hem niet laat vallen. Nakijken zodra die host weer
    // antwoordt.
    category: { '@id': 'https://funkwhale.audio/ns#category' },
    // FEP-633c (Guardians): the shaer namespace, owned by the guardianship
    // module (src/services/guardianship/).
    ...Guardianship.SHAER_CONTEXT,
  },
];

/** Een absolute http(s)-URL, of leeg. De enige plek die bepaalt wat wij een
 *  bruikbare URL vinden. */
export const safeUrl = (u) => { const s = String(u == null ? '' : u).trim(); return /^https?:\/\//i.test(s) ? s : ''; };

export function actorId(base, slug) { return `${base}/ap/users/${encodeURIComponent(slug)}`; }
export function noteId(base, postId) { return `${base}/ap/notes/${encodeURIComponent(postId)}`; }

/**
 * mediaType raden uit een bestandsnaam. Stond twee keer functie-lokaal in dit
 * bestand, met een commentaar dat ze "dezelfde afleiding" waren -- en dat was
 * niet zo: de ene kende video, de andere alleen beeld. Nu een kaart, hier.
 * De terugval is image/jpeg omdat dit alleen op omslagen en bijlagen wordt
 * losgelaten, nooit op geluid: dat draagt zijn eigen mime_type uit de database.
 */
export function guessMediaType(u) {
  const e = ((u || '').split('?')[0].match(/\.(\w+)$/) || [])[1];
  return ({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  })[(e || '').toLowerCase()] || 'image/jpeg';
}

/**
 * Het tagveld van een post als lijst. Het staat in de database als JSON-ARRAY
 * en niet als kommalijst -- op komma's splitsen levert `#["Doen we Niet"` op,
 * en dat faalt niet, het liegt. Vandaar een echte parser, met de kommavorm als
 * terugval voor wat er handmatig is ingevuld.
 */
export function normalizeTags(t) {
  if (Array.isArray(t)) return t;
  if (typeof t === 'string') {
    const s = t.trim(); if (!s) return [];
    if (s[0] === '[') { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { /* dan toch als kommalijst */ } }
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Een tag -> { label, slug }. Tags van meerdere woorden worden CamelCase
 * (#LiveMusic) voor de weergavenaam -- een Mastodon-hashtag mag geen spaties
 * bevatten en CamelCase is daar de toegankelijkheidsnorm; de slug en de href
 * blijven kleingeschreven ("livemusic").
 */
export function tagParts(raw) {
  const words = String(raw || '').trim().split(/[\s_]+/).map((w) => w.replace(/[^\p{L}\p{M}\p{N}]/gu, '')).filter(Boolean);
  if (!words.length) return null;
  const slug = words.join('').toLowerCase();
  if (!slug) return null;
  const label = words.length > 1 ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join('') : words[0];
  return { label, slug };
}

/**
 * De #hashtags die in het LIJF van een post gelinkt staan, zoals ze GESCHREVEN
 * zijn. De slug in de href is kleingeschreven -- dat is een adres -- maar de
 * naam niet: #DoenweNiet blijft #DoenweNiet.
 */
export function hashtagTags(base, content) {
  const tags = [], seen = new Set();
  const re = /class="[^"]*\bhashtag\b[^"]*"[^>]*>#([\p{L}\p{M}\p{N}_]+)</giu;
  let m;
  while ((m = re.exec(content || ''))) {
    const k = m[1].toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    tags.push({ type: 'Hashtag', href: `${base}/tag/${encodeURIComponent(k)}`, name: '#' + m[1] });
  }
  return tags;
}

/**
 * Het tagveld van een post en de #hashtags uit het lijf, samen en ontdubbeld.
 *
 * HET LIJF GAAT VOOR (Robin, 9-8): staat een tag allebei, dan wint de vorm
 * zoals hij GESCHREVEN is. Het tagveld gaat door tagParts, en die maakt van
 * "Doen we Niet" het CamelCase #DoenWeNiet -- nodig, want een hashtag mag geen
 * spaties bevatten. Maar als iemand in zijn tekst #DoenweNiet heeft getypt is
 * dat geen benadering meer maar de tag zelf, en dan hoort die te staan zoals
 * hij er staat. Eerder won het veld, en verdween de geschreven vorm.
 *
 * `opts.ruw` voor inhoud die nog niet door de renderer is geweest: dan staan de
 * hashtags er als kale tekst en niet als <a class="hashtag">. buildNote krijgt
 * het bewerkte lijf en heeft dit niet nodig; wie rechtstreeks uit posts.content
 * leest wel -- anders vindt hij er geen enkele en valt hij stil terug op het
 * tagveld, precies de vorm die hier juist niet moest winnen.
 */
export function hashtagTagsRuw(base, content) {
  const tags = [], seen = new Set();
  // Moet met een LETTER beginnen: "#12" in "issue #12" is een nummer en geen
  // tag, en die zou hier anders als hashtag de deur uit gaan.
  const re = /(^|[\s>(\[])#(\p{L}[\p{L}\p{M}\p{N}_]*)/gu;
  let m;
  while ((m = re.exec(content || ''))) {
    const k = m[2].toLowerCase();
    if (seen.has(k)) continue; seen.add(k);
    tags.push({ type: 'Hashtag', href: `${base}/tag/${encodeURIComponent(k)}`, name: '#' + m[2] });
  }
  return tags;
}

export function buildHashtagList(base, tagsField, content, opts = {}) {
  const out = [], seen = new Set();
  const uitLijf = opts.ruw
    ? [...hashtagTags(base, content), ...hashtagTagsRuw(base, content)]
    : hashtagTags(base, content);
  for (const h of uitLijf) {
    const k = h.name.slice(1).toLowerCase(); if (seen.has(k)) continue; seen.add(k);
    out.push(h);
  }
  for (const t of normalizeTags(tagsField)) {
    const p = tagParts(t); if (!p || seen.has(p.slug)) continue; seen.add(p.slug);
    out.push({ type: 'Hashtag', href: `${base}/tag/${encodeURIComponent(p.slug)}`, name: '#' + p.label });
  }
  return out;
}

/**
 * Een AS2-collectie MET de paginavelden erbij (shaer-0nh, 11-8).
 *
 * WAAROM DIT EEN HELPER IS EN GEEN REGELS. Funkwhale weigerde onze outbox met
 * "first: This field is required" en "last: This field is required" -- de eerste
 * concrete reden die we hoorden waarom er niets van ons binnenkwam. AS2 EIST die
 * velden niet, maar bijna iedereen pagineert, en een lezer die de paginaweg
 * volgt liep dood. Toen dat voor de outbox gerepareerd was misten alle andere
 * collecties ze nog steeds. Een helper zorgt dat de volgende collectie ze niet
 * opnieuw vergeet.
 *
 * DE ITEMS BLIJVEN INLINE op de wortel. Shaer bouwt zijn feed daaruit, en wie
 * hem vandaag leest hoort er morgen niet voor te hoeven pagineren. Onze
 * collecties zijn gekapt, dus er is precies EEN pagina en wijzen first en last
 * naar dezelfde.
 *
 * @param {string} id        de collectie-uri, zonder query
 * @param {Array}  items     wat erin zit (mag leeg)
 * @param {object} opts
 *   totalItems  als de telling niet items.length is (followers geeft publiek
 *               alleen een AANTAL en houdt de lijst dicht)
 *   page        true -> een OrderedCollectionPage met partOf in plaats van de wortel
 *   extra       velden die op de wortel horen (attributedTo, shaer:*)
 */
/** Hoeveel items op een pagina. Gelijk aan wat de outbox vroeger als KAP had. */
export const PAGINA_GROOTTE = 20;

/**
 * Een collectie, met ECHTE paginering (shaer-sk4).
 *
 * Wat hier stond was een omhulsel: `page` veranderde alleen de VORM en er werd
 * nooit gesneden. `first` en `last` wezen allebei naar ?page=1, elke ?page=N gaf
 * dezelfde items, en pagina 99 noemde zichzelf pagina 1. Robin zag dat de
 * pagina's identiek bleven; dit is waarom.
 *
 * DE WORTEL BLIJFT ZIJN ITEMS INLINE DRAGEN, en dat is geen slordigheid maar de
 * hele reden dat dit veilig is. Shaer leest één document en volgt `next` niet;
 * zou de wortel nu leeg worden, dan kreeg elke draaiende app nul items en geen
 * foutmelding. Eerst de clients leren pagineren, dan pas de wortel afslanken.
 *
 * Een pagina VOORBIJ het einde is leeg en zegt dat ook -- met zijn eigen nummer
 * en zonder `next`. Hem naar de laatste pagina terugbuigen zou opnieuw een
 * antwoord zijn dat over zichzelf liegt.
 *
 * `ongeordend` maakt er de NIET-geordende vorm van: `Collection` met
 * `CollectionPage` en `items`, in plaats van `OrderedCollection` met
 * `OrderedCollectionPage` en `orderedItems`. Dat is geen dialect maar de andere
 * helft van AS2 -- en de bibliotheek hoort daar: een platenkast heeft geen
 * volgorde die iets betekent, en `Library` is bij Funkwhale expliciet een
 * `Collection`. Onze outbox is wél geordend (chronologie is daar de inhoud) en
 * blijft dus zoals hij was.
 *
 * De pagina draagt in die vorm ook `first` en `last`. AS2 staat dat toe --
 * CollectionPage erft van Collection -- en een lezer die halverwege binnenkomt
 * kan zo terug naar het begin zonder eerst de wortel op te halen.
 */
export function pagedCollection(id, items, { totalItems, page = false, perPage = PAGINA_GROOTTE, alGesneden = false, ongeordend = false, extra = {} } = {}) {
  const lijst = items || [];
  const telling = totalItems === undefined ? lijst.length : totalItems;
  const grootte = Math.max(1, Number(perPage) || PAGINA_GROOTTE);
  // `alGesneden` voor wie in SQL al gepagineerd heeft (de outbox): dan is `lijst`
  // een PAGINA en zegt hij niets over het geheel, dus telt het aantal pagina's
  // uit `totalItems`. Zonder dat zou een volle pagina zichzelf als de enige zien
  // en nooit een `next` aanbieden.
  const paginas = Math.max(1, Math.ceil((alGesneden ? telling : lijst.length) / grootte));
  const url = (n) => `${id}?page=${n}`;

  if (page) {
    const n = Math.max(1, Math.floor(Number(page)) || 1);
    const deel = alGesneden ? lijst : lijst.slice((n - 1) * grootte, n * grootte);
    return {
      '@context': AP_CONTEXT,
      id: url(n),
      type: ongeordend ? 'CollectionPage' : 'OrderedCollectionPage',
      partOf: id,
      totalItems: telling,
      ...(ongeordend ? { first: url(1), last: url(paginas) } : {}),
      ...(extra.attributedTo ? { attributedTo: extra.attributedTo } : {}),
      ...(n > 1 ? { prev: url(n - 1) } : {}),
      ...(n < paginas ? { next: url(n + 1) } : {}),
      ...(ongeordend ? { items: deel } : { orderedItems: deel }),
    };
  }
  return {
    '@context': AP_CONTEXT,
    id,
    type: ongeordend ? 'Collection' : 'OrderedCollection',
    ...extra,
    totalItems: telling,
    first: url(1),
    last: url(paginas),
    ...(ongeordend ? { items: lijst } : { orderedItems: lijst }),
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
