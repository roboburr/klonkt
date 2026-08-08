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
