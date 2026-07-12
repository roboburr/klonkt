/**
 * HtmlSanitizerService — clean user-authored HTML from the WYSIWYG editor
 * before storing it in the DB.
 *
 * Pipeline order on the render side (posts.js):
 *   1. content already sanitized HTML (this service ran on save)
 *   2. autoembed → adds iframes for Spotify/YouTube/etc (server-controlled, safe)
 *   3. shortcode replacement → adds custom embed HTML (server-controlled, safe)
 *
 * Shortcodes like [[track:UUID]] / [[album:Name]] / [[playlist:slug]] live in
 * text nodes — sanitize-html preserves text, so they pass through untouched.
 */

import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  // Block
  'p', 'div', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre',
  'ul', 'ol', 'li',
  'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  // Inline
  'strong', 'em', 'b', 'i', 'u', 's', 'mark', 'small', 'sub', 'sup',
  'code', 'a', 'span', 'img',
  // Native media (bare .webm/.mp4/.mp3 embeds + federated-in players)
  'video', 'audio', 'source',
];

// Per-tag attribute allowlist. '*' applies to every tag.
const ALLOWED_ATTRS = {
  '*':   ['class', 'id', 'dir', 'lang', 'data-sc'],
  a:     ['href', 'title', 'target', 'rel'],
  img:   ['src', 'alt', 'title', 'width', 'height', 'loading'],
  video: ['src', 'controls', 'preload', 'poster', 'width', 'height', 'loop', 'muted', 'autoplay', 'playsinline'],
  audio: ['src', 'controls', 'preload', 'loop', 'muted', 'autoplay'],
  source: ['src', 'type'],
};

const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'];
const ALLOWED_SCHEMES_BY_TAG = {
  img:    ['http', 'https', 'data'],
  a:      ['http', 'https', 'mailto', 'tel'],
  video:  ['http', 'https'],
  audio:  ['http', 'https'],
  source: ['http', 'https'],
};

class HtmlSanitizerService {
  /**
   * Sanitize user HTML. Returns a clean string ready for DB storage.
   * Empty input → empty string. Anything that would have rendered as a
   * <script>, inline event handler, or javascript: URL is stripped.
   */
  static sanitize(html) {
    if (!html || typeof html !== 'string') return '';
    return sanitizeHtml(html, {
      allowedTags: ALLOWED_TAGS,
      allowedAttributes: ALLOWED_ATTRS,
      allowedSchemes: ALLOWED_SCHEMES,
      allowedSchemesByTag: ALLOWED_SCHEMES_BY_TAG,
      // Drop entire <script>/<style> contents (default behaviour just strips
      // tags and keeps inner text — we want the contents gone too).
      nonTextTags: ['script', 'style', 'textarea', 'noscript'],
      // Force external links to be safe-by-default. Server-side rewrite is
      // simpler than a CSP header for this case.
      transformTags: {
        a: (tagName, attribs) => {
          const out = { tagName, attribs: { ...attribs } };
          const href = (attribs.href || '').trim();
          if (/^https?:\/\//i.test(href)) {
            out.attribs.target = out.attribs.target || '_blank';
            out.attribs.rel = 'noopener noreferrer';
          }
          return out;
        },
      },
    });
  }

  /**
   * Plain-text extract for excerpts / search snippets. Removes ALL HTML
   * (not the same as sanitize — this strips everything down to text).
   */
  static toPlainText(html) {
    if (!html) return '';
    return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
      .replace(/\s+/g, ' ')
      .trim();
  }
}

export default HtmlSanitizerService;
