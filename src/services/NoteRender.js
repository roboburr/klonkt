// Server-side rendering of the bits the Shaer clients render natively, so the
// Klonkt web timeline looks the same: FEP-9098 custom emojis (`:shortcode:` →
// image) in note content and display names, and the FEP-044f embedded quote
// card. Pure + deterministic (no DB, no I/O), so it is unit-testable and cheap.

const SHORTCODE = /:[A-Za-z0-9_+-]+:/g;

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => HTML_ESCAPES[c]);
}

// Normalise either representation into a { ":shortcode:": url } map:
//  - emoji_json: an array of Emoji tag objects [{ name, icon:{url} }]
//  - author_emoji_json / reblog_emoji_json / quote.emojis: already a map.
export function emojiMap(json) {
  try {
    const v = json == null ? null : (typeof json === 'string' ? JSON.parse(json) : json);
    if (!v) return {};
    if (Array.isArray(v)) {
      const m = {};
      for (const t of v) {
        const icon = t && t.icon;
        const url = icon && (icon.url || (Array.isArray(icon) && icon[0] && icon[0].url));
        if (t && typeof t.name === 'string' && url) m[t.name] = url;
      }
      return m;
    }
    if (typeof v === 'object') {
      const m = {};
      for (const k of Object.keys(v)) if (typeof v[k] === 'string') m[k] = v[k];
      return m;
    }
    return {};
  } catch { return {}; }
}

function emojiImg(url, alt) {
  return `<img class="emoji" src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" title="${escapeAttr(alt)}" draggable="false" loading="lazy">`;
}

function substitute(text, map) {
  return text.replace(SHORTCODE, (m) => (map[m] ? emojiImg(map[m], m) : m));
}

// Inject <img> for each known custom emoji into an already-sanitised HTML
// fragment (note content). Substitutes only in text between tags (never inside
// a tag or its attributes) and skips <code>/<pre>, mirroring the Shaer render.
export function emojiHtml(html, json) {
  const map = emojiMap(json);
  if (!html || !Object.keys(map).length) return html || '';
  let out = '';
  let i = 0;
  let code = 0;
  while (i < html.length) {
    if (html[i] === '<') {
      const close = html.indexOf('>', i);
      if (close < 0) { out += html.slice(i); break; }
      const raw = html.slice(i + 1, close);
      const name = raw.replace(/^\//, '').split(/[\s/>]/)[0].toLowerCase();
      if (name === 'code' || name === 'pre') code = Math.max(0, code + (raw[0] === '/' ? -1 : 1));
      out += html.slice(i, close + 1);   // copy the tag verbatim
      i = close + 1;
    } else {
      const next = html.indexOf('<', i);
      const end = next < 0 ? html.length : next;
      const text = html.slice(i, end);
      out += code > 0 ? text : substitute(text, map);
      i = end;
    }
  }
  return out;
}

// A plain-text display name with custom emojis → safe HTML. The name is HTML-
// escaped first; shortcode characters ([A-Za-z0-9_+-]) survive escaping, so the
// image substitution stays correct.
export function emojiName(text, json) {
  const esc = escapeHtml(text);
  const map = emojiMap(json);
  if (!Object.keys(map).length) return esc;
  return substitute(esc, map);
}

// The resolved quoted-post snapshot Klonkt stored (quote_json), or null.
export function parseQuote(json) {
  try {
    const q = json == null ? null : (typeof json === 'string' ? JSON.parse(json) : json);
    return (q && typeof q === 'object' && q.url) ? q : null;
  } catch { return null; }
}

export default { escapeHtml, emojiMap, emojiHtml, emojiName, parseQuote };
