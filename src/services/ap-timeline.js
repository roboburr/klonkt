/**
 * ap-timeline.js — de leeskant van de fediverse-tijdlijn (stap 5 van shaer-drc).
 *
 * Alles wat een client of route uit ap_timeline en de gesprekken LEEST:
 * de tijdlijn zelf, de feed-cursor met long-poll, de gesprekslijsten en
 * leesmarkeringen, en de serialisatiehulpen (bijlagen, emoji, object-links,
 * citaten) die een rij naar de C2S-vorm vertalen.
 *
 * De SCHRIJFKANT blijft waar hij was: de inbox, de backfill en self-heal
 * schrijven via tlStmts, dat hierom mee-exporteert. Een module importeert
 * nooit uit ActivityPubService; de ene uitzondering op "alleen omlaag" --
 * getReactionsFor, uit het reactiecluster -- komt daarom binnen via
 * wireTimeline, hetzelfde injectiepatroon als guardianship en ap-c2s.
 */
import db from '../config/database.js';

// Het ene werktuig uit de dienstlaag. ActivityPubService vult het onderaan
// zijn eigen evaluatie; een aanroep voor de koppeling is een programmeerfout.
let getReactionsFor;
export function wireTimeline(deps) {
  ({ getReactionsFor } = deps);
}

let _insTl, _listTl, _delTl;
export function tlStmts() {
  if (!_insTl) {
    _insTl = db.prepare('INSERT OR IGNORE INTO ap_timeline (id, slug, author_uri, author_name, author_handle, author_icon, author_url, content, url, published, media_json, nsfw, cw, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)');
    _listTl = db.prepare('SELECT * FROM ap_timeline WHERE slug = ? ORDER BY COALESCE(published, created_at) DESC LIMIT ? OFFSET ?');
    _delTl = db.prepare('DELETE FROM ap_timeline WHERE id = ?');
  }
  return { ins: _insTl, list: _listTl, del: _delTl };
}
/**
 * De tijdlijn, met liked/boosted uit de TUSSENTABEL (shaer-9e9).
 *
 * De rijen komen met SELECT *, dus ap_timeline.liked en .boosted liften mee --
 * en die zijn sinds fase 1 nog maar een afgeleide. De Krant tekende zijn
 * knoppen daar wel op, terwijl de toggle al uit getReaction besliste: tekenen en
 * beslissen leunden dus op verschillende bronnen. Ze waren het eens zolang de
 * migratie ze gelijk hield, maar dat was synchronisatie en geen ontwerp.
 *
 * Bewust in JS en niet als join: met SELECT * zouden twee kolommen `liked`
 * heten en hangt het van de driver af welke wint. Eén extra query per pagina
 * (dezelfde batch die de C2S-tijdlijn gebruikt) is dat niet waard.
 */
export function getTimeline(slug, limit, offset) {
  const rows = tlStmts().list.all(slug, limit || 50, offset || 0);
  const reacties = getReactionsFor(slug, rows.map((r) => r.id));
  for (const r of rows) {
    const x = reacties.get(r.id);
    r.liked = !!(x && x.liked);
    r.boosted = !!(x && x.boosted);
  }
  return rows;
}

/**
 * The direct notes addressed to this account: a plain DM, a guardian's wave
 * (§5), a ward's 🛟 help request (§5.2.1). They live in ap_mentions and NOT in
 * the timeline, because a note addressed to named people is a message and not a
 * post (belongsInTimeline).
 *
 * A client that only reads the timeline therefore sees none of them, which is
 * exactly what happened to Shaer: Berichten showed your own replies (those come
 * from your outbox) and nothing that was said to you. The C2S inbox read serves
 * both, so the app has one door for everything that arrives.
 *
 * A public mention from someone you follow is stored in both tables; those are
 * skipped here and stay a post.
 */
// Inbound replies on YOUR posts, for the app's message stream. They live in
// ap_interactions (the web's comment machinery) and deliberately NOT in
// ap_mentions (the mention store returns early for replies-to-us), so the
// C2S read missed them entirely: a reply arrived at the other side
// everywhere EXCEPT in the other's app (Robins melding, 30-7: "komt niet
// binnen bij de ander").
const REPLY_COLUMNS = `
      i.object_uri, i.actor_uri, i.actor_name, i.actor_handle, i.actor_icon, i.actor_url,
      i.content, i.published, i.created_at, i.parent_uri, i.post_id,
      i.emoji_json, i.actor_emoji_json, i.media_json, i.quote_json, i.embed_json`;

/** Dezelfde antwoordrijen, maar op object-uri -- voor de verschil-lezing. */
export function replyRowsByUri(slug, uris) {
  const list = (uris || []).filter((u) => typeof u === 'string' && u);
  if (!list.length) return [];
  try {
    const holes = list.map(() => '?').join(',');
    return db.prepare(`SELECT ${REPLY_COLUMNS} FROM ap_interactions i
                        JOIN posts p ON p.id = i.post_id
                        JOIN sites s ON s.id = p.site_id
                       WHERE s.slug = ? AND i.kind = 'reply' AND i.object_uri IN (${holes})`)
      .all(slug, ...list);
  } catch { return []; }
}

/** Tijdlijnrijen op id, met dezelfde afgeleide liked/boosted als getTimeline. */
export function timelineRowsByIds(slug, ids) {
  const list = (ids || []).filter((u) => typeof u === 'string' && u);
  if (!list.length) return [];
  try {
    const holes = list.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM ap_timeline WHERE slug = ? AND id IN (${holes})`).all(slug, ...list);
    const reacties = getReactionsFor(slug, rows.map((r) => r.id));
    for (const r of rows) {
      const x = reacties.get(r.id);
      r.liked = !!(x && x.liked);
      r.boosted = !!(x && x.boosted);
    }
    return rows;
  } catch { return []; }
}

export function getReplyMessages(slug, limit) {
  try {
    return db.prepare(`
      SELECT ${REPLY_COLUMNS}
      FROM ap_interactions i
      JOIN posts p ON p.id = i.post_id
      JOIN sites s ON s.id = p.site_id
      WHERE s.slug = ? AND i.kind = 'reply'
      ORDER BY COALESCE(i.published, i.created_at) DESC LIMIT ?`).all(slug, limit || 60);
  } catch { return []; }
}

/**
 * Een merk voor "is er iets veranderd aan wat de inbox-lezing zou opleveren?"
 * (shaer-n05).
 *
 * Alle VIER de poten die de inbox samenvoegt tellen mee -- tijdlijn, berichten,
 * antwoorden op je eigen posts, en wat je zelf verstuurde. Zou er een ontbreken,
 * dan blijft een wachtende client slapen terwijl er wel degelijk iets is
 * bijgekomen, en dat is erger dan niet wachten: het lijkt te werken.
 *
 * rowid en niet een tijdstempel: rowid loopt strikt op per invoeging, terwijl
 * twee dingen in dezelfde seconde kunnen aankomen en een `published` van een
 * andere server niet te vertrouwen is.
 *
 * Ondoorzichtig voor de client. Hij krijgt hem terug en geeft hem ongewijzigd
 * mee; de vorm mag veranderen zonder dat dat iets breekt.
 */
export function feedCursor(slug) {
  try {
    const r = db.prepare('SELECT MAX(rev) AS n FROM ap_feed_state WHERE slug = ?').get(slug);
    return String((r && r.n) || 0);
  } catch { return '0'; }
}

/**
 * Wat er sinds `rev` met deze tijdlijn gebeurd is: welke berichten er nieuw zijn,
 * bewerkt, of weg.
 *
 * Nog niet gebruikt door een leespad -- de vorm van de aankomst is shaer-of7 en
 * de "bewerkt"-markering is daar nog een open beslissing. Maar de gegevens
 * ontstaan hoe dan ook bij het bijhouden van de merksteen, en dit is de enige
 * plek waar ze samen te lezen zijn.
 */
export function feedChangesSince(slug, rev, limit = 200) {
  try {
    return db.prepare(`SELECT object_uri, kind, rev FROM ap_feed_state
                        WHERE slug = ? AND rev > ? ORDER BY rev ASC LIMIT ?`)
      .all(slug, parseInt(rev, 10) || 0, limit);
  } catch { return []; }
}

// Zoveel clients mogen er tegelijk op EEN account staan wachten. Een client met
// een kapotte herverbind-lus mag de instance niet vastzetten; de overtolligen
// krijgen gewoon meteen antwoord in plaats van een fout.
const FEED_WAIT_MAX = 4;
const _wachters = new Map();

/**
 * Wacht tot de inbox-lezing iets anders zou opleveren dan bij `since`.
 *
 * Bewust met een interne tik en niet met een gebeurtenis-emitter. Een emitter
 * moet op ELKE plek worden aangeroepen waar er iets bijkomt, en de plek die je
 * vergeet is precies de melding die nooit aankomt. Twee tot vier MAX(rowid)-
 * queries per seconde is niets, en dit kan niets missen. Prijs: hooguit een tik
 * vertraging.
 */
export async function waitForFeedChange(slug, opts = {}) {
  const tickMs = Math.max(50, opts.tickMs || 1000);
  const waitMs = Math.max(0, opts.waitMs || 0);
  const since = String(opts.since || '');
  let cursor = feedCursor(slug);
  // Geen sinds, al iets veranderd, of niet willen wachten: meteen antwoorden.
  if (!since || since !== cursor || !waitMs) return { cursor, changed: !!since && since !== cursor, waited: false };

  const bezet = _wachters.get(slug) || 0;
  if (bezet >= FEED_WAIT_MAX) return { cursor, changed: false, waited: false, busy: true };
  _wachters.set(slug, bezet + 1);
  try {
    const einde = Date.now() + waitMs;
    while (Date.now() < einde) {
      if (opts.signal && opts.signal.aborted) break;   // client hing op
      const rest = Math.min(tickMs, einde - Date.now());
      await new Promise((r) => setTimeout(r, rest));
      cursor = feedCursor(slug);
      if (cursor !== since) return { cursor, changed: true, waited: true };
    }
    return { cursor, changed: false, waited: true };
  } finally {
    const n = (_wachters.get(slug) || 1) - 1;
    if (n > 0) _wachters.set(slug, n); else _wachters.delete(slug);
  }
}

// ── Gesprekken: eerst wie, dan pas wat (shaer-frontend-yso) ──────────
//
// De oude lezing gaf de nieuwste 60 berichten over ALLE gesprekken samen. Dat
// knipt geschiedenis weg zonder dat iemand het merkt, en het is bij DM's veel
// erger dan bij posts: dat zijn er meer en het zijn kortere berichten, dus een
// druk gesprek kan de 60 in zijn eentje opeten en de rest uit de lezing duwen.
// Viel het laatste bericht van iemand erbuiten, dan verdween die persoon
// helemaal uit Messages -- de avatarhemel plaatst mensen op de leeftijd van hun
// laatste bericht, dus geen bericht is geen gezicht.
//
// Vandaar twee lezingen. Deze geeft EEN rij per tegenpartij, hoe druk iemand
// ook is, en conversationHistory hieronder geeft het gesprek zelf met een
// cursor. Wat de client van de hemel nodig heeft -- wie, wanneer, en waarmee --
// zit in die ene nieuwste note.
//
// Een gesprek is hier hetzelfde als in de app: incoming zijn de ap_mentions
// (die tabel IS de aan ons gerichte post), uitgaand zijn de eigen notes met
// visibility 'direct'. Een publiek antwoord is geen gesprek en hoort niet als
// gezicht in de hemel.
/**
 * EEN STEMPEL IN EEN VORM, en dat is hier geen netheid maar de volgorde zelf.
 *
 * Drie vormen kwamen samen in deze unie: `2026-08-13 19:26:17` van SQLite's
 * CURRENT_TIMESTAMP, `2026-08-13T18:21:57Z` uit een object, en dezelfde met
 * milliseconden. Als TEKST vergeleken staat op plek 10 een spatie tegen een
 * T -- en een spatie is kleiner. Dus sorteerde binnen dezelfde dag alles wat
 * JIJ stuurde vóór alles wat binnenkwam, ongeacht de klok (Barts melding 14-8:
 * een bericht van 00:30 stond boven een antwoord van 20:22 de avond ervoor).
 *
 * strftime leest alle drie en geeft er een vorm voor terug, in UTC. Lukt het
 * niet, dan blijft de rauwe waarde staan -- dan is die ene rij verkeerd
 * gesorteerd in plaats van de hele lijst.
 *
 * Dit gaat ook de client aan: `new Date('2026-08-13 19:26:17')` leest in
 * JavaScript als LOKALE tijd en `...T19:26:17Z` als UTC. Dezelfde rij gaf dus
 * een leeftijd die twee uur verschilde per vorm.
 */
const STEMPEL = (rauw) => `COALESCE(strftime('%Y-%m-%dT%H:%M:%SZ', ${rauw}), ${rauw})`;

const CONVERSATION_UNION = `
  SELECT m.actor_uri AS other, ${STEMPEL('COALESCE(m.published, m.created_at)')} AS stamp,
         'in' AS direction, m.object_uri AS ref
    FROM ap_mentions m
   WHERE m.slug = @slug AND m.actor_uri IS NOT NULL AND m.actor_uri <> ''
  UNION ALL
  SELECT j.value AS other, ${STEMPEL('o.created_at')} AS stamp,
         'out' AS direction, o.id AS ref
    FROM ap_outbox o
    JOIN json_each(COALESCE(NULLIF(o.to_actors, ''), json_array(o.to_actor))) j
   WHERE o.site_slug = @slug AND o.visibility = 'direct'
     AND j.value IS NOT NULL AND j.value <> ''`;

/**
 * Een rij per tegenpartij: zijn nieuwste bericht, nieuwste gesprek eerst.
 *
 * Compleet van vorm -- het aantal rijen is het aantal mensen, niet het aantal
 * berichten -- dus de hemel kan niemand meer kwijtraken doordat een ander druk
 * was. Zonder limiet, en dat mag: dit schaalt met je kring.
 */
export function conversationHeads(slug) {
  try {
    // Twee rijen per persoon, niet een: het nieuwste bericht (dat bepaalt waar
    // iemand in de hemel hangt) EN het nieuwste bericht VAN HEM.
    //
    // Die tweede is er omdat het nieuwste bericht van jou kan zijn, en dan
    // draagt het jouw byline. De hemel zoekt de naam en het gezicht van de
    // ander in een bericht van de ander -- vond hij dat niet, dan viel hij
    // terug op het staartje van de actor-uri en heette tante opeens
    // 'hotelbreakfast'. Op het toestel gezien, 10-8.
    //
    // Valt het samen (het nieuwste is al van hem), dan is het een rij; dubbel
    // sturen doen we niet.
    return db.prepare(`
      SELECT other, stamp, direction, ref FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY other ORDER BY stamp DESC, ref DESC) AS rn
          FROM (${CONVERSATION_UNION})
      ) WHERE rn = 1
      UNION
      SELECT other, stamp, direction, ref FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY other ORDER BY stamp DESC, ref DESC) AS rn
          FROM (${CONVERSATION_UNION}) WHERE direction = 'in'
      ) WHERE rn = 1
      ORDER BY stamp DESC, ref DESC`).all({ slug });
  } catch { return []; }
}

/**
 * Een gesprek, nieuwste eerst, met een cursor.
 *
 * BEIDE KANTEN ONDER EEN LIMIET. In de oude lezing werden jouw kant
 * (getSentNotes) en hun kant apart afgekapt, waardoor een gesprek eenzijdig
 * kon lijken -- alsof iemand nooit geantwoord had. Hier is de limiet er een
 * voor het gesprek als geheel.
 *
 * `before` is de cursor van het OUDSTE bericht dat je al hebt; je krijgt wat
 * daarvoor ligt. Er komt er een extra op om te weten of er nog meer is: de
 * client hoort dat te weten zonder te moeten gokken, en zonder dat weten kan
 * 'load more' niet eerlijk verschijnen.
 *
 * DE CURSOR IS SAMENGESTELD -- '<stempel>|<ref>' -- en niet alleen de stempel.
 * Twee berichten in dezelfde seconde is bij DM's geen randgeval maar een
 * gesprek, en met 'stamp < before' zou alles wat die grensseconde deelt stil
 * overgeslagen worden. Je zou het niet merken: de pagina komt gewoon, er
 * ontbreekt alleen iets in het midden.
 */
const cursorOf = (r) => (r ? `${r.stamp}|${r.ref}` : null);

export function conversationHistory(slug, other, { before = null, limit = 60 } = {}) {
  try {
    const n = Math.min(Math.max(parseInt(limit, 10) || 60, 1), 200);
    const sep = String(before || '').indexOf('|');
    const bStamp = before && sep > 0 ? String(before).slice(0, sep) : null;
    const bRef = before && sep > 0 ? String(before).slice(sep + 1) : null;
    const rows = db.prepare(`
      SELECT other, stamp, direction, ref FROM (${CONVERSATION_UNION})
       WHERE other = @other
         AND (@bStamp IS NULL OR stamp < @bStamp OR (stamp = @bStamp AND ref < @bRef))
       ORDER BY stamp DESC, ref DESC LIMIT @n`).all({ slug, other, bStamp, bRef, n: n + 1 });
    const more = rows.length > n;
    const page = more ? rows.slice(0, n) : rows;
    return { rows: page, more, oldest: cursorOf(page[page.length - 1]) };
  } catch { return { rows: [], more: false, oldest: null }; }
}

// De kolommen die een bericht tot kaart maken. Een constante, want de
// gesprekslezing haalt dezelfde rows op: twee lijsten die uiteenlopen leveren
// een kaart die op de ene plek een plaatje heeft en op de andere niet.
const MESSAGE_COLUMNS = `
      m.object_uri, m.note_url, m.actor_uri, m.actor_name, m.actor_handle, m.actor_icon, m.actor_url,
      m.content, m.published, m.created_at, m.wave, m.help_request, m.in_reply_to,
      m.emoji_json, m.actor_emoji_json, m.media_json, m.quote_json, m.embed_json`;

/** Dezelfde berichtrijen, maar op object-uri -- voor een gesprek. */
export function messageRowsByUri(slug, uris) {
  const lijst = (uris || []).filter((u) => typeof u === 'string' && u);
  if (!lijst.length) return [];
  try {
    const gaten = lijst.map(() => '?').join(',');
    return db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM ap_mentions m
                        WHERE m.slug = ? AND m.object_uri IN (${gaten})`).all(slug, ...lijst);
  } catch { return []; }
}

/**
 * Tot waar deze lezer elk gesprek gelezen heeft (shaer-frontend-3tx).
 *
 * De markering komt uit AS2 `Read`-activiteiten, en die zijn OPTELLEND: het
 * lezen van bericht N maakt niets anders ongelezen. Daarom is achteruit gaan
 * geen regel die iemand moet onthouden maar een eigenschap van het model --
 * markRead neemt het maximum. Een 'zet mijn markering op X' zou een toestel
 * dat een week uit stond je gelezen berichten weer op ongelezen laten zetten.
 */
export function readMarkers(slug) {
  try {
    return new Map(db.prepare('SELECT other, cursor FROM ap_read_markers WHERE slug = ?')
      .all(slug).map((r) => [r.other, r.cursor]));
  } catch { return new Map(); }
}

/**
 * Markeer een gesprek als gelezen tot en met dit bericht.
 *
 * Het object van de Read is een berichturi; welk gesprek dat is en waar het in
 * de tijd staat weet de server zelf, dus de client hoeft niets uit te rekenen
 * en kan er ook niet naast zitten.
 */
export function markRead(slug, objectUri) {
  try {
    const rij = db.prepare(`SELECT other, stamp, ref FROM (${CONVERSATION_UNION})
                             WHERE ref = @ref ORDER BY stamp DESC LIMIT 1`)
      .get({ slug, ref: String(objectUri || '') });
    if (!rij) return null;
    const cursor = `${rij.stamp}|${rij.ref}`;
    db.prepare(`INSERT INTO ap_read_markers (slug, other, cursor) VALUES (?,?,?)
                ON CONFLICT(slug, other) DO UPDATE SET cursor = MAX(cursor, excluded.cursor), at = CURRENT_TIMESTAMP`)
      .run(slug, rij.other, cursor);
    return { other: rij.other, cursor };
  } catch { return null; }
}

/**
 * Hoeveel er per gesprek nog ongelezen is, en of daar een zwaai bij zit.
 *
 * Een COUNT en geen bijgehouden getal (Barts besluit): niets om op te hogen
 * bij bezorging, niets om te verlagen bij lezen, en bij een verwijdering klopt
 * het vanzelf weer.
 *
 * Een zwaai telt apart, want dat is geen gesprek maar een zetje van een
 * guardian -- die hoort een eigen teken te krijgen en niet opgeteld te worden.
 * Eigen berichten tellen nooit mee: je hebt jezelf gelezen.
 */
export function unreadPerConversation(slug, { messagesAllowed = true, guardians = new Set() } = {}) {
  try {
    // DE POORT TELT MEE. Staat messages dicht, dan toont de app die berichten
    // niet -- en dan mag een badge ze ook niet aankondigen, want dat getal
    // vertelt precies wat de poort verbergt. Wat er altijd door mag telt wel:
    // het guardian-kanaal en de boei. Zelfde regel als bij de serialisatie.
    const rijen = db.prepare(`
      SELECT u.other AS other,
             COUNT(*) AS n,
             MAX(CASE WHEN m.wave = 1 THEN 1 ELSE 0 END) AS wave
        FROM (${CONVERSATION_UNION}) u
        LEFT JOIN ap_read_markers r ON r.slug = @slug AND r.other = u.other
        LEFT JOIN ap_mentions m ON m.slug = @slug AND m.object_uri = u.ref
       WHERE u.direction = 'in'
         AND (r.cursor IS NULL OR (u.stamp || '|' || u.ref) > r.cursor)
         AND (@open = 1 OR m.help_request = 1 OR u.other IN (SELECT value FROM json_each(@guardians)))
       GROUP BY u.other`)
      .all({ slug, open: messagesAllowed ? 1 : 0, guardians: JSON.stringify([...guardians]) });
    return new Map(rijen.map((r) => [r.other, { n: r.n, wave: !!r.wave }]));
  } catch { return new Map(); }
}

export function getDirectMessages(slug, limit) {
  try {
    return db.prepare(`
      SELECT ${MESSAGE_COLUMNS}
      FROM ap_mentions m
      WHERE m.slug = ?
        AND NOT EXISTS (SELECT 1 FROM ap_timeline t WHERE t.slug = m.slug AND t.id = m.object_uri)
      ORDER BY COALESCE(m.published, m.created_at) DESC LIMIT ?`).all(slug, limit || 60);
  } catch { return []; }
}

/**
 * A stored stamp as an ISO instant. SQLite's CURRENT_TIMESTAMP writes
 * 'YYYY-MM-DD HH:MM:SS' in UTC, which Date.parse reads as LOCAL time; on a
 * server two hours ahead that dated every message two hours early and put the
 * conversation in the wrong order. A `published` from the wire is already ISO
 * and passes through untouched.
 */
export function isoStamp(v) {
  if (!v) return undefined;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(s)) return `${s.replace(' ', 'T')}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Inbox C2S read: a timeline row's media_json ([{url, type}], written on the
// inbound Create) → AS2 `attachment` array, so a client (Shaer) can render a
// friend's images/audio/video natively, exactly like own outbox posts. The
// stored `type` is the mediaType and may be ''. Malformed JSON yields
// undefined and never blocks the item.
export function timelineAttachments(mediaJson) {
  try {
    const list = mediaJson ? JSON.parse(mediaJson) : [];
    const rows = (Array.isArray(list) ? list : [])
      .filter((m) => m && m.url)
      .map((m) => {
        const a = { type: 'Document', mediaType: m.type || undefined, url: m.url };
        if (m.poster) a.icon = { type: 'Image', url: m.poster }; // the video's still (shaer-zowq)
        return a;
      });
    return rows.length ? rows : undefined;
  } catch { return undefined; }
}

// FEP-9098 custom emojis. Inbound: keep the note's Emoji tags (as JSON) so we
// can serve them back. `extractEmojiTags` returns the JSON to store (or null);
// `timelineEmojis` turns the stored JSON back into an AS2 `tag` array for the
// C2S inbox read, so a client (Shaer) can render :shortcode: as an image.
export function extractEmojiTags(tag) {
  const arr = Array.isArray(tag) ? tag : (tag ? [tag] : []);
  const emojis = arr.filter((t) => t && (Array.isArray(t.type) ? t.type[0] : t.type) === 'Emoji'
    && typeof t.name === 'string' && t.icon);
  return emojis.length ? JSON.stringify(emojis) : null;
}
// ── Gate-filters voor de C2S-serialisatie (shaer-ahy.1, 8-8) ──────
//
// Dezelfde regel als bij de embeds: de poort zit bij de AFLEVERING. Een
// bijlage die de client alleen verbergt is wel degelijk geleverd, dus wat
// dicht is wordt hier nooit geserialiseerd. Puur, zodat de regels los van de
// routes te toetsen zijn.

/** Bijlagen door de beeld- en muziekpoort. Leeg wordt undefined, zoals de
 *  serialisatie dat overal doet. */
export function gateAttachments(atts, { images = true, audio = true } = {}) {
  if (!Array.isArray(atts)) return atts;
  const out = atts.filter((a) => {
    const mt = String((a && a.mediaType) || '');
    if (!images && mt.startsWith('image/')) return false;
    if (!audio && (mt.startsWith('audio/') || (a && a.type === 'Audio'))) return false;
    return true;
  });
  return out.length ? out : undefined;
}

/** Tag-array zonder de FEP-9098 Emoji-tags, voor een dichte emoji-poort. De
 *  :shortcode: blijft als tekst staan -- dat is eerlijk: er STAAT iets, het
 *  wordt alleen niet als plaatje van een vreemde server gerenderd. */
export function stripEmojiTags(tags) {
  if (!Array.isArray(tags)) return tags;
  const out = tags.filter((t) => (Array.isArray(t && t.type) ? t.type[0] : (t && t.type)) !== 'Emoji');
  return out.length ? out : undefined;
}

export function timelineEmojis(emojiJson) {
  try { const arr = emojiJson ? JSON.parse(emojiJson) : null; return (Array.isArray(arr) && arr.length) ? arr : undefined; }
  catch { return undefined; }
}

// FEP-e232 object links (quotes / inline references). Inbound: keep the note's
// Link tags whose mediaType marks an AP object (the AS2-profiled ld+json, or
// activity+json as its equivalent) as JSON, so the C2S inbox read can serve
// them back and a client (Shaer) can render the quote/reference. Mirrors
// extractEmojiTags. Plain hyperlinks (text/html) and Mentions are dropped.
export function extractObjectLinkTags(tag) {
  const arr = Array.isArray(tag) ? tag : (tag ? [tag] : []);
  const links = arr.filter((t) => {
    if (!t || (Array.isArray(t.type) ? t.type[0] : t.type) !== 'Link') return false;
    if (typeof t.href !== 'string' || !t.href) return false;
    const mt = String(t.mediaType || '').toLowerCase();
    return (mt.startsWith('application/ld+json') && mt.includes('activitystreams'))
      || mt.startsWith('application/activity+json');
  });
  return links.length ? JSON.stringify(links) : null;
}
export function timelineObjectLinks(linkJson) {
  try { const arr = linkJson ? JSON.parse(linkJson) : null; return (Array.isArray(arr) && arr.length) ? arr : undefined; }
  catch { return undefined; }
}

// FEP-044f quote posts: a quote is usually NOT an FEP-e232 tag but an
// object-level property. FEP-044f §"how to recognise" lists them all:
// `quote` (the FEP property, a string or an embedded Link/object), and the
// de-facto `quoteUrl` (as:), `quoteUri` (fedibird), `_misskey_quote` (misskey).
// This returns the quoted object's URL from whichever is present.
export function extractQuoteUrl(note) {
  if (!note || typeof note !== 'object') return null;
  const q = note.quote ?? note.quoteUrl ?? note.quoteUri ?? note['_misskey_quote'];
  if (!q) return null;
  if (typeof q === 'string') return q || null;
  if (typeof q === 'object') return (typeof q.id === 'string' && q.id) || (typeof q.href === 'string' && q.href) || null;
  return null;
}

// The note's object-link tags for storage: real FEP-e232 Link tags PLUS any
// FEP-044f object-level quote, normalised to one FEP-e232-shaped Link (rel
// _misskey_quote) so the client's single object-link path renders them all.
// Deduped by href. Returns the JSON to store (or null if the note has neither).
export function extractLinkJson(note) {
  const links = [];
  const fromTag = extractObjectLinkTags(note && note.tag);
  if (fromTag) { try { links.push(...JSON.parse(fromTag)); } catch { /* ignore */ } }
  const qUrl = extractQuoteUrl(note);
  if (qUrl && !links.some((l) => l && l.href === qUrl)) {
    links.push({ type: 'Link', mediaType: 'application/activity+json', href: qUrl,
      rel: ['https://misskey-hub.net/ns#_misskey_quote'], name: qUrl });
  }
  return links.length ? JSON.stringify(links) : null;
}

// The URL of the quoted post, from either an object-level quote (FEP-044f) or a
// quote-rel FEP-e232 Link tag. Used to resolve the embedded quote card.
export function quoteHrefOf(note) {
  const direct = extractQuoteUrl(note);
  if (direct) return direct;
  const arr = Array.isArray(note && note.tag) ? note.tag : (note && note.tag ? [note.tag] : []);
  for (const t of arr) {
    if (!t || (Array.isArray(t.type) ? t.type[0] : t.type) !== 'Link' || typeof t.href !== 'string') continue;
    const rel = Array.isArray(t.rel) ? t.rel : (t.rel ? [t.rel] : []);
    if (rel.some((r) => /quote/i.test(String(r)))) return t.href;
  }
  return null;
}

// Turn the stored quote snapshot back into the object the C2S inbox read serves
// as `shaer:quote`, so the client can render the embedded quote card.
export function timelineQuote(quoteJson) {
  try { const q = quoteJson ? JSON.parse(quoteJson) : null; return (q && typeof q === 'object') ? q : undefined; }
  catch { return undefined; }
}
