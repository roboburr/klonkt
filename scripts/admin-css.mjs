/**
 * Vergelijkt de ax-*-regels van een beheerpagina met partials/admin-styles.ejs.
 *
 *   node scripts/admin-css.mjs                 wat zou er gebeuren (leest alleen)
 *   node scripts/admin-css.mjs --doen          haalt de dubbele regels weg
 *
 * WAAROM EEN ONTLEDING EN GEEN GREP. De eerste poging (16-8) telde
 * @media-varianten als losse regels en commentaar als selector, en concludeerde
 * daaruit dat admin-playlists tien "eigen" regels had die het niet had. Een
 * verkeerd patroon faalt niet, hij liegt. Dit leest de tekens een voor een: hij
 * kent commentaar, tekenreeksen en geneste blokken, en houdt bij in welke
 * @media-context een regel staat -- want .ax-track in een media query is een
 * ANDERE regel dan .ax-track daarbuiten.
 *
 * WAT HIJ WEGHAALT: alleen regels die in dezelfde context dezelfde selector en
 * exact dezelfde verklaringen hebben als de partial. Wijkt er iets af, dan
 * blijft hij staan en wordt hij gemeld -- dat is een bewuste afwijking van die
 * pagina en niet aan een script om op te ruimen. De partial hoort BOVENAAN de
 * pagina te staan, zodat wat blijft staan later komt en dus wint.
 */
import fs from 'node:fs';

/** Splitst CSS in blokken. Geen regex: tekens tellen, met besef van context. */
function ontleed(css, context = '') {
  const uit = [];
  let i = 0, start = 0, diepte = 0, blokStart = -1;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    // Commentaar overslaan -- ook een { of } daarbinnen telt niet mee.
    if (c === '/' && css[i + 1] === '*') {
      const eind = css.indexOf('*/', i + 2);
      i = eind === -1 ? n : eind + 2;
      continue;
    }
    // Tekenreeksen overslaan (content: "}" bestaat echt).
    if (c === '"' || c === "'") {
      const aanhaal = c; i++;
      while (i < n && css[i] !== aanhaal) { if (css[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '{') {
      if (diepte === 0) blokStart = i;
      diepte++; i++; continue;
    }
    if (c === '}') {
      diepte--;
      if (diepte === 0) {
        // Commentaar ERAF voor we kijken wat voor blok dit is. Stond dit na de
        // controle, dan werd `/* Mobiel */ @media (...)` niet als media query
        // herkend en telde het hele blok als een gewone regel met een
        // krankzinnige selector -- en de regels erbinnen werden nooit
        // vergeleken. De eerste versie deed dat, en het viel alleen op omdat de
        // uitvoer "@media (max-width: 480px)" als selector noemde.
        const kop = norm(schoon(css.slice(start, blokStart)));
        const lijf = css.slice(blokStart + 1, i);
        if (kop.startsWith('@media') || kop.startsWith('@supports')) {
          // Genest: de binnenkant is zelf weer een regelverzameling. De posities
          // die daaruit komen zijn RELATIEF aan lijf, dus schuif ze naar deze
          // tekst op -- anders knipt het weghalen straks de verkeerde bytes,
          // en dat is het soort fout dat een bestand stilletjes sloopt.
          const verschuif = blokStart + 1;
          for (const r of ontleed(lijf, kop)) {
            uit.push({ ...r, van: r.van + verschuif, tot: r.tot + verschuif });
          }
        } else {
          uit.push({
            context,
            selector: kop,
            verklaringen: normVerklaringen(lijf),
            van: start, tot: i + 1,
          });
        }
        start = i + 1;
      }
      i++; continue;
    }
    i++;
  }
  return uit;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();
/** Commentaar voor een selector hoort bij de selector niet. */
const schoon = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
/** Verklaringen als gesorteerde verzameling: volgorde binnen een blok telt niet. */
function normVerklaringen(lijf) {
  return schoon(lijf).split(';').map((d) => norm(d)).filter(Boolean).sort().join('; ');
}

function styleBlok(bestand) {
  const tekst = fs.readFileSync(bestand, 'utf8');
  const m = /<style>([\s\S]*?)<\/style>/.exec(tekst);
  return m ? { tekst, css: m[1], van: m.index + '<style>'.length } : null;
}

const PARTIAL = 'src/views/partials/admin-styles.ejs';
const PAGINAS = process.argv.filter((a) => a.endsWith('.ejs') && a !== PARTIAL);
const doen = process.argv.includes('--doen');
// --forceer haalt OOK de regels weg die dezelfde selector hebben maar een
// andere waarde: de pagina neemt dan de vorm van de partial over. Apart van
// --doen omdat het iets anders is -- --doen verplaatst, dit VERANDERT hoe de
// pagina eruitziet, en dat hoort een expliciete keuze te zijn.
const forceer = process.argv.includes('--forceer');

const gedeeld = new Map();
for (const r of ontleed(styleBlok(PARTIAL).css)) {
  gedeeld.set(`${r.context}||${r.selector}`, r.verklaringen);
}
console.log(`partial: ${gedeeld.size} regels\n`);

for (const pad of PAGINAS) {
  const blok = styleBlok(pad);
  if (!blok) { console.log(`${pad}: geen style-blok`); continue; }
  const regels = ontleed(blok.css);
  const dubbel = [], anders = [], eigen = [];
  for (const r of regels) {
    const sleutel = `${r.context}||${r.selector}`;
    if (!gedeeld.has(sleutel)) eigen.push(r);
    else if (gedeeld.get(sleutel) === r.verklaringen) dubbel.push(r);
    else anders.push(r);
  }
  console.log(`${pad}`);
  console.log(`  ${dubbel.length} identiek aan de partial  ->  weg`);
  console.log(`  ${anders.length} zelfde selector, ANDERE waarde  ->  blijft staan`);
  for (const r of anders) {
    console.log(`      ${r.context ? r.context + ' ' : ''}${r.selector}`);
    if (process.argv.includes('--toon')) {
      const g = gedeeld.get(`${r.context}||${r.selector}`);
      // Alleen de eigenschappen die ECHT verschillen, anders verzuipt het
      // verschil in twintig regels die identiek zijn.
      const kaart = (v) => new Map(v.split('; ').map((d) => [d.split(':')[0].trim(), d]));
      const [ga, ra] = [kaart(g), kaart(r.verklaringen)];
      for (const k of new Set([...ga.keys(), ...ra.keys()])) {
        if (ga.get(k) !== ra.get(k)) console.log(`          partial: ${ga.get(k) || '(niets)'}\n          pagina : ${ra.get(k) || '(niets)'}`);
      }
    }
  }
  console.log(`  ${eigen.length} alleen op deze pagina  ->  blijft staan`);

  const weg = forceer ? [...dubbel, ...anders] : dubbel;
  if (doen && weg.length) {
    // Van achter naar voren knippen, anders schuiven de posities.
    let css = blok.css;
    for (const r of [...weg].sort((a, b) => b.van - a.van)) {
      css = css.slice(0, r.van) + css.slice(r.tot);
    }
    css = css.replace(/\n{3,}/g, '\n\n');
    const nieuw = blok.tekst.slice(0, blok.van) + css + blok.tekst.slice(blok.van + blok.css.length);
    fs.writeFileSync(pad, nieuw);
    console.log(`  geschreven (${weg.length} regels weg${forceer ? ', waarvan ' + anders.length + ' afwijkend' : ''})`);
  }
  console.log();
}
