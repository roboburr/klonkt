// One pipeline for everything you can drop a URL of into a post, and one visual
// result. What differs is not what a reader sees but what FEDERATES.
//
// Resolution order (Robins besluit, shaer-277):
//   1. ActivityPub object  → the FEP path. A quote of a fediverse object carries
//      real semantics: FEP-044f `quote` + an FEP-e232 Link tag, the quoted
//      author gets addressed, and the permission model applies. Never resolved
//      over oEmbed, because oEmbed has none of that.
//   2. oEmbed, else OpenGraph → one page fetch, and no list of providers to
//      maintain. Whether an embed may be shown at all is a guardian decision
//      (the gate), not a question of which host it came from.
//   3. Otherwise           → a plain link.
//
// Everything returns the SAME normalised shape, so one renderer draws them all
// (the quote card). Pure except for the two injected fetchers, so the ordering
// logic is unit-testable without a network.

const OEMBED_LINK = /<link\b[^>]*>/gi;

/** Pull the oEmbed endpoint out of a page's <link rel="alternate"> tags. */
export function findOEmbedEndpoint(html) {
  if (!html || typeof html !== 'string') return null;
  for (const tag of html.match(OEMBED_LINK) || []) {
    const type = (tag.match(/\btype\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (!/application\/(json|xml)\+oembed/i.test(type)) continue;
    const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
    if (rel && !/alternate/i.test(rel)) continue;
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1];
    // JSON only: we do not parse the XML flavour.
    if (href && /json/i.test(type)) return decodeEntities(href);
  }
  return null;
}

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * OpenGraph, the one that actually carries link previews on the open web.
 * oEmbed is the richer protocol but most sites simply do not implement it;
 * og:image / og:title is what Mastodon and everyone else reads, so it is the
 * fallback that makes thumbnails appear at all. Same page fetch as the oEmbed
 * discovery, so it costs nothing extra.
 */
export function findOpenGraph(html) {
  if (!html || typeof html !== 'string') return null;
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!key) continue;
    const k = key.toLowerCase();
    if (!/^(og:image|og:title|og:site_name|og:description|twitter:image|twitter:title)$/.test(k)) continue;
    const val = (tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (val && !meta[k]) meta[k] = decodeEntities(val);
  }
  const image = meta['og:image'] || meta['twitter:image'];
  const title = meta['og:title'] || meta['twitter:title'];
  if (!image && !title) return null;
  return { image: image && /^https?:\/\//i.test(image) ? image : null, title: title || null, site: meta['og:site_name'] || null };
}

/** Is this JSON an ActivityPub object we can quote? */
export function looksLikeAPObject(doc) {
  if (!doc || typeof doc !== 'object') return false;
  const t = Array.isArray(doc.type) ? doc.type[0] : doc.type;
  if (typeof t !== 'string') return false;
  // Quotable content, not an actor and not an activity.
  return ['Note', 'Article', 'Page', 'Video', 'Audio', 'Image', 'Question', 'Event'].includes(t)
    && typeof doc.id === 'string';
}

/** An oEmbed payload → the shared card shape. */
export function fromOEmbed(url, o) {
  if (!o || typeof o !== 'object') return null;
  const media = [];
  if (o.thumbnail_url) media.push({ url: String(o.thumbnail_url), type: 'image/*' });
  return {
    kind: 'oembed',
    url: typeof o.url === 'string' && /^https?:/i.test(o.url) ? o.url : url,
    title: o.title ? String(o.title) : null,
    author: (o.author_name || o.provider_name) ? {
      name: o.author_name ? String(o.author_name) : String(o.provider_name),
      handle: o.provider_name ? String(o.provider_name) : null,
      icon: null,
    } : null,
    // `html` is the provider's own iframe. Kept separate from the card body so
    // a caller can decide to frame it or to fall back to the thumbnail; it is
    // never merged into sanitized note content.
    html: typeof o.html === 'string' ? o.html : null,
    provider: o.provider_name ? String(o.provider_name) : null,
    media,
  };
}

/** An AP object → the same shape a resolved quote already uses. */
export function fromAPObject(url, doc, author) {
  const attributed = typeof doc.attributedTo === 'string' ? doc.attributedTo
    : (doc.attributedTo && typeof doc.attributedTo.id === 'string' ? doc.attributedTo.id : null);
  return {
    kind: 'ap',
    url: (typeof doc.url === 'string' && doc.url) || doc.id || url,
    id: doc.id,
    attributedTo: attributed,
    title: doc.name ? String(doc.name) : null,
    content: typeof doc.content === 'string' ? doc.content : '',
    published: doc.published || null,
    author: author || null,
    media: [],
  };
}

/**
 * Resolve one URL to the shared card shape.
 *
 * @param {string} url
 * @param {object} io
 *   - getAP(url)      → the AP JSON (Accept: application/activity+json) or null
 *   - getPage(url)    → the HTML body or null
 *   - getJSON(url)    → arbitrary JSON (the oEmbed endpoint) or null
 *   - actorOf(uri)    → { name, handle, icon } for the AP author, or null
 *   - provider(url)   → the known-provider hit (AudioEmbedService.detectProvider)
 */
export async function resolveEmbed(url, io = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;

  // 1. ActivityPub first: it is the only path that carries quote semantics.
  if (io.getAP) {
    const doc = await io.getAP(url).catch(() => null);
    if (looksLikeAPObject(doc)) {
      const attributed = typeof doc.attributedTo === 'string' ? doc.attributedTo
        : (doc.attributedTo && doc.attributedTo.id);
      const author = (attributed && io.actorOf) ? await io.actorOf(attributed).catch(() => null) : null;
      return fromAPObject(url, doc, author);
    }
  }

  // 2. oEmbed, then OpenGraph. One page fetch serves both: oEmbed is the richer
  //    protocol, OpenGraph is the one most of the web actually ships.
  //
  //    There is deliberately NO list of known providers here. A hardcoded list
  //    is a whitelist you have to keep maintaining, and it was actively harmful:
  //    a YouTube link matched the list, short-circuited before oEmbed, and came
  //    out as a card with no title and no thumbnail, so nothing was stored at
  //    all. YouTube serves both oEmbed and og:image like everyone else, so the
  //    generic path handles it better than the special case did.
  if (io.getPage) {
    const page = await io.getPage(url).catch(() => null);
    if (page) {
      const endpoint = findOEmbedEndpoint(page);
      if (endpoint && io.getJSON) {
        const o = await io.getJSON(endpoint).catch(() => null);
        const card = fromOEmbed(url, o);
        if (card) return card;
      }
      const og = findOpenGraph(page);
      if (og) {
        return {
          kind: 'opengraph',
          url,
          title: og.title,
          author: og.site ? { name: og.site, handle: null, icon: null } : null,
          provider: og.site,
          html: null,
          media: og.image ? [{ url: og.image, type: 'image/*' }] : [],
        };
      }
    }
  }

  // 4. Nothing recognised it: a link stays a link.
  return { kind: 'link', url, media: [] };
}

// ── The wired-up variant ──────────────────────────────────────────
// The io above is injected so the ordering is testable without a network.
// This binds it to the real, SSRF-safe fetchers. Every fetch is capped and
// goes through safeFetch (which refuses private ranges and caps redirects),
// so a hostile URL in a post cannot make the server probe an internal host.

const MAX_JSON = 512_000;   // an oEmbed/AP payload must parse whole, so cap and refuse
// Of a web page we only ever need the <head>. The cap has to clear the worst
// real case rather than the tidy one: YouTube ships ~665kB of inline script
// before its og:image and closes <head> at ~673kB, and at 512kB we cut the page
// off just short of the tags and produced nothing. We stop as soon as the tags
// are in hand, so a normal page still costs a few dozen kB.
const MAX_HEAD = 1_048_576;
const UA = 'Mozilla/5.0 (compatible; Klonkt/1.0; +https://klonkt.com)';

/** A whole small document, refused when it is too big to be one. */
async function safeJsonText(safeFetch, url, accept) {
  try {
    const r = await safeFetch(url, { headers: { Accept: accept } });
    if (!r.ok) return null;
    if (Number(r.headers.get('content-length') || 0) > MAX_JSON) return null;
    const body = await r.text();
    return body.length > MAX_JSON ? null : body;   // truncated JSON is useless
  } catch { return null; }
}

/**
 * The START of a web page, streamed and cut off at MAX_HEAD.
 *
 * Refusing a page for being large was wrong: YouTube's watch page is megabytes,
 * so it was rejected outright and never produced a thumbnail, even though its
 * og:image sits in the first few kilobytes like everyone else's. We only ever
 * read the <head>, so read that much and stop pulling. The cap still protects
 * us from someone streaming us an endless body.
 */
async function safeHead(safeFetch, url, extra = {}) {
  try {
    const r = await safeFetch(url, { headers: { Accept: 'text/html,application/xhtml+xml', ...extra } });
    if (!r.ok) return null;
    if (!r.body || typeof r.body.getReader !== 'function') {
      const body = await r.text();                       // no stream (or a test double)
      return body.length > MAX_HEAD ? body.slice(0, MAX_HEAD) : body;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder('utf-8');
    const parts = [];
    let len = 0;
    let tail = '';        // carry a little context so a tag split across chunks still matches
    let done_ = false;
    while (!done_) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      parts.push(chunk);
      len += chunk.length;
      // Scan only the new chunk (plus overlap), not the whole buffer: testing
      // the full string every read turns a 1MB page into quadratic work.
      const window = tail + chunk;
      if (len >= MAX_HEAD || /<\/head>/i.test(window) || /og:image/i.test(window)) done_ = true;
      tail = chunk.slice(-512);
    }
    try { await reader.cancel(); } catch { /* already closed */ }
    return parts.join('').slice(0, MAX_HEAD);
  } catch { return null; }
}

/**
 * Bind the resolver to the live fetchers.
 * @param {object} deps - { safeFetch, detectProvider, actorInfo, fetchActor }
 */
export function liveIO({ safeFetch, detectProvider, fetchActor, actorInfo }) {
  return {
    provider: detectProvider ? (u) => { try { return detectProvider(u); } catch { return null; } } : null,
    getAP: async (u) => {
      const body = await safeJsonText(safeFetch, u, 'application/activity+json, application/ld+json');
      if (!body) return null;
      try { return JSON.parse(body); } catch { return null; }   // an HTML page is simply not AP
    },
    // Plenty of sites only hand out their OpenGraph tags to something that
    // looks like a browser, so the page fetch identifies itself.
    getPage: (u) => safeHead(safeFetch, u, { 'User-Agent': UA }),
    getJSON: async (u) => {
      const body = await safeJsonText(safeFetch, u, 'application/json');
      if (!body) return null;
      try { return JSON.parse(body); } catch { return null; }
    },
    actorOf: async (uri) => {
      if (!fetchActor || !actorInfo) return null;
      const doc = await fetchActor(uri).catch(() => null);
      if (!doc) return null;
      const ai = actorInfo(doc, uri);
      return { name: ai.name, handle: ai.handle, icon: ai.icon, emojis: ai.emojis };
    },
  };
}

export default { resolveEmbed, findOEmbedEndpoint, findOpenGraph, looksLikeAPObject, fromOEmbed, fromAPObject, liveIO };
