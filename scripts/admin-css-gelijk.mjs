/**
 * Bewijst dat het ontdubbelen niets aan de OPMAAK heeft veranderd.
 *
 *   node scripts/admin-css-gelijk.mjs <git-ref>     (standaard HEAD)
 *
 * Rendert elke beheerpagina twee keer -- zoals hij nu is, en zoals hij in de
 * opgegeven git-ref was -- verzamelt uit de uitvoer ALLE style-blokken, en
 * rekent per (media-context, selector) uit welke verklaringen er uiteindelijk
 * gelden. Later in het document wint, zoals in een browser.
 *
 * Daarna legt hij de twee kaarten naast elkaar. Gelijk = de ingreep was
 * werkelijk alleen verplaatsen.
 *
 * WAAROM DIT NODIG IS. "De tests zijn groen" zegt hier niets: de suite raakt
 * geen enkele view. En "het rendert" ook niet: een pagina die zijn halve
 * opmaak kwijt is rendert prima. Zo raakten audio en playlists hun tabbalk
 * kwijt -- de markup stond er, de regels niet, en niets viel om.
 *
 * WEL VERWACHT: regels die ERBIJ komen. De partial brengt .ax-tab en .ax-tabs
 * mee, en dat is de hele bedoeling. Die worden apart gemeld, niet als fout.
 */
import fs from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';

// De OUDE views als map, niet als git-ref: de testkloon op de server heeft geen
// .git, en een controle die alleen in een werkboom kan draaien is er een die je
// daar niet draait.
//   git archive <ref> src/views | tar x -C /tmp/oud
//   node scripts/admin-css-gelijk.mjs /tmp/oud
const OUD = process.argv[2];
if (!OUD) { console.error('gebruik: node scripts/admin-css-gelijk.mjs <map met oude src/views>'); process.exit(2); }

const basis = {
  t: (k) => k, thumb: (u) => u, formatDate: (d) => String(d || ''),
  audioOn: true, success: null, error: null, csrfToken: 'x',
  siteUrlBase: '', locale: 'nl',
};
const PAGINAS = {
  'admin-audio': { tracks: [], playlists: [], maxBytesMb: 20, maxWavMb: 100, site: { id: 's1', slug: 'x' } },
  'admin-playlists': { playlists: [] },
  'admin-media': { items: [], unusedCount: 0 },
  'admin-videos': { items: [] },
  'admin-listeners': { luisteraars: [] },
};

// ── dezelfde ontleding als admin-css.mjs ──────────────────────────
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const schoon = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
function ontleed(css, context = '') {
  const uit = []; let i = 0, start = 0, diepte = 0, blokStart = -1;
  while (i < css.length) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e === -1 ? css.length : e + 2; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < css.length && css[i] !== q) { if (css[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{') { if (diepte === 0) blokStart = i; diepte++; i++; continue; }
    if (c === '}') {
      diepte--;
      if (diepte === 0) {
        const kop = norm(schoon(css.slice(start, blokStart)));
        const lijf = css.slice(blokStart + 1, i);
        if (kop.startsWith('@media') || kop.startsWith('@supports')) uit.push(...ontleed(lijf, kop));
        else uit.push({ context, selector: kop, verklaringen: schoon(lijf).split(';').map(norm).filter(Boolean).sort().join('; ') });
        start = i + 1;
      }
      i++; continue;
    }
    i++;
  }
  return uit;
}

/** Wat geldt er uiteindelijk: later in het document wint. */
function effectief(html) {
  const kaart = new Map();
  for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    for (const r of ontleed(m[1])) kaart.set(`${r.context}||${r.selector}`, r.verklaringen);
  }
  return kaart;
}

let stuk = 0;
for (const [naam, data] of Object.entries(PAGINAS)) {
  const locals = { ...basis, ...data };
  let nu, toen;
  try { nu = effectief(await ejs.renderFile(`src/views/pages/${naam}.ejs`, locals)); }
  catch (e) { console.log(`STUK ${naam} (nu): ${e.message.split('\n')[0]}`); stuk++; continue; }
  try { toen = effectief(await ejs.renderFile(path.join(OUD, `src/views/pages/${naam}.ejs`), locals)); }
  catch (e) { console.log(`?    ${naam}: oude versie rendert niet (${e.message.split('\n')[0]}) -- overgeslagen`); continue; }

  const verdwenen = [...toen.keys()].filter((k) => !nu.has(k));
  const veranderd = [...toen.keys()].filter((k) => nu.has(k) && nu.get(k) !== toen.get(k));
  const nieuw = [...nu.keys()].filter((k) => !toen.has(k));

  if (verdwenen.length || veranderd.length) {
    stuk++;
    console.log(`STUK ${naam}`);
    for (const k of verdwenen) console.log(`   WEG        ${k.replace('||', ' ')}`);
    for (const k of veranderd) console.log(`   VERANDERD  ${k.replace('||', ' ')}\n        was: ${toen.get(k)}\n        is : ${nu.get(k)}`);
  } else {
    console.log(`OK   ${naam}  ${toen.size} regels ongewijzigd, ${nieuw.length} erbij`);
    for (const k of nieuw) console.log(`        + ${k.replace('||', ' ')}`);
  }
}
console.log(stuk ? `\n${stuk} pagina('s) veranderd van opmaak` : '\nopmaak identiek');
process.exit(stuk ? 1 : 0);
