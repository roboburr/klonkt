/**
 * OgImageService — generates a themed Open Graph card (1200x630 PNG) per site,
 * derived from the site's palette + accent, so every site has a branded social
 * preview even without uploading one. SVG is hand-built and rasterized with
 * @resvg/resvg-js. Result is cached on disk (keyed by the theming inputs).
 *
 * Graceful: if @resvg/resvg-js can't load (exotic platform), ogImageFor()
 * returns null and the caller falls back to no/other og:image — never throws.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import ThemeService from './ThemeService.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FONT = path.join(__dirname, '..', 'assets', 'fonts', 'fraunces-og.ttf');
const DATA_DIR = path.dirname(process.env.DATABASE_PATH || './storage/database.sqlite');
const CACHE_DIR = path.join(DATA_DIR, 'og');
const TEMPLATE_VERSION = 1; // bump to invalidate all cached cards after a design change

let _Resvg = null, _tried = false;
function getResvg() {
  if (_tried) return _Resvg;
  _tried = true;
  try { _Resvg = require('@resvg/resvg-js').Resvg; } catch { _Resvg = null; }
  return _Resvg;
}

// ── tiny colour helpers ───────────────────────────────────────────
function hx(h) {
  h = String(h || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
}
function rgb(a) {
  return '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function mix(a, b, t) { const A = hx(a), B = hx(b); return rgb(A.map((v, i) => v + (B[i] - v) * t)); }
function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

function buildSvg(site, palette, accent, theme) {
  const _p = ThemeService.PALETTES[palette] || ThemeService.PALETTES.klonkt;
  const pal = _p[theme] || _p.dark;
  const paper = pal.paper, ink = pal.ink;
  const paper2 = mix(paper, ink, 0.08);
  const muted = mix(ink, paper, 0.42);

  let title = (site.title || 'Klonkt').trim();
  let tag = (site.tagline || site.description || '').trim();
  if (title.length > 38) title = title.slice(0, 37) + '…';
  if (tag.length > 74) tag = tag.slice(0, 73) + '…';
  const tsize = title.length <= 12 ? 100 : title.length <= 20 ? 82 : title.length <= 30 ? 64 : 54;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${paper}"/><stop offset="1" stop-color="${paper2}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.85" cy="0.12" r="0.7">
      <stop offset="0" stop-color="${accent}" stop-opacity="0.20"/>
      <stop offset="1" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="14" height="630" fill="${accent}"/>
  <g transform="translate(96,232)">
    <rect x="0"  y="14" width="11" height="34" rx="3" fill="${accent}"/>
    <rect x="18" y="0"  width="11" height="48" rx="3" fill="${accent}"/>
    <rect x="36" y="22" width="11" height="26" rx="3" fill="${accent}"/>
    <rect x="54" y="8"  width="11" height="40" rx="3" fill="${accent}"/>
  </g>
  <text x="96" y="400" font-size="${tsize}" fill="${ink}">${esc(title)}</text>
  ${tag ? `<text x="98" y="462" font-size="34" fill="${muted}">${esc(tag)}</text>` : ''}
  <text x="96" y="566" font-size="30" fill="${accent}">klonkt</text>
</svg>`;
}

/**
 * Returns a PNG Buffer of the site's OG card (cached), or null if generation
 * isn't possible. `site` needs: slug, title, palette, accent, tagline/description.
 */
export function ogImageFor(site) {
  const Resvg = getResvg();
  if (!Resvg || !site || !site.slug) return null;

  const palette = ThemeService.PALETTES[site.palette] ? site.palette : 'klonkt';
  // Follow the site's "default theme for new visitors" (theme_override): a light card when the site
  // is set to Light, otherwise dark (an OG image is static, so Auto/Dark → dark).
  const theme = site.theme_override === 'light' ? 'light' : 'dark';
  const accent = site.accent || ((ThemeService.PALETTES[palette] || ThemeService.PALETTES.klonkt)[theme] || ThemeService.PALETTES.klonkt.dark).accent;
  const key = crypto.createHash('sha1')
    .update([TEMPLATE_VERSION, site.slug, palette, accent, theme, site.title || '', site.tagline || site.description || ''].join('\x1f'))
    .digest('hex').slice(0, 16);
  const file = path.join(CACHE_DIR, key + '.png');

  try { return fs.readFileSync(file); } catch { /* not cached yet */ }

  try {
    const svg = buildSvg(site, palette, accent, theme);
    const png = new Resvg(svg, {
      font: { fontFiles: [FONT], loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(file, png); } catch { /* cache best-effort */ }
    return png;
  } catch {
    return null;
  }
}

export default { ogImageFor };
