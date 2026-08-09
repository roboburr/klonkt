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
    position: 'schema:position',
    bitrate: 'schema:bitrate',
    size: 'schema:contentSize',
    // Poll (Question) extension: Question/oneOf/anyOf/endTime/closed are AS2 core, but the
    // per-poll unique-voter count is a Mastodon (toot) term — declare it so the emitted
    // Question stays valid JSON-LD (a strict processor would otherwise drop votersCount).
    votersCount: 'toot:votersCount',
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
