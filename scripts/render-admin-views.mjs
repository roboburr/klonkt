/**
 * Rendert de beheer-views los, gevuld en leeg.
 *
 * WAAROM DIT ER IS. De testsuite raakt de EJS-views niet aan: op 16-8 stond hij
 * op 1040 groen terwijl partials/admin-styles.ejs niet eens kon parsen ("Could
 * not find matching close tag"). Een controle die niet kan falen op wat je
 * verandert is geen bewijs -- en aan een view verander je opmaak, dus faalt de
 * suite er nooit op.
 *
 * Hij dekt BEIDE takken: met items en zonder. De lege tak is andere code, en
 * dat is net de tak die je bij het bouwen niet ziet omdat je scherm vol staat.
 *
 * LET OP: rendert bewust ZONDER { async: true }. Met die vlag levert `include`
 * een Promise op die als "[object Promise]" in de uitvoer belandt -- dat kostte
 * hier een ronde. De app rendert ook synchroon.
 *
 *   node scripts/render-admin-views.mjs
 */
import ejs from 'ejs';

const t = (k) => k;
const basis = {
  t, thumb: (u) => u, formatDate: (d) => String(d || ''),
  audioOn: true, success: null, error: null, csrfToken: 'x',
  siteUrlBase: '', locale: 'nl',
};

const gevuld = {
  'admin-audio': { tracks: [], playlists: [], maxBytesMb: 20, maxWavMb: 100 },
  'admin-playlists': { playlists: [] },
  'admin-media': { items: [{ file: 'a.jpg', url: '/m/a.jpg', kb: 12, usedCount: 0, hasVideo: true }], unusedCount: 1 },
  'admin-videos': { items: [{ file: 'b.mp4', url: '/m/b.mp4', kb: 99, usedCount: 2 }] },
  'admin-listeners': { luisteraars: [{ actor_uri: 'https://x/y', name: 'Zoe', handle: '@zoe@x', icon: '/i.png', created_at: '2026-08-01', last_delivery_at: null, last_error_at: '2026-08-02' }] },
};
const leeg = {
  'admin-audio': { tracks: [], playlists: [], maxBytesMb: 20, maxWavMb: 100 },
  'admin-playlists': { playlists: [] },
  'admin-media': { items: [], unusedCount: 0 },
  'admin-videos': { items: [] },
  'admin-listeners': { luisteraars: [] },
};

let stuk = 0;
for (const naam of Object.keys(gevuld)) {
  for (const [label, data] of [['gevuld', gevuld[naam]], ['leeg', leeg[naam]]]) {
    try {
      const html = await ejs.renderFile(`src/views/pages/${naam}.ejs`, { ...basis, ...data });
      const fouten = [];
      // Tellen op de MARKUP, niet op de opmaak: het style-blok bevat zelf ook
      // `aria-current="page"` (als selector) en telde eerst vrolijk mee.
      const markup = html.replace(/<style>[\s\S]*?<\/style>/g, '');
      // De vijf tabs moeten er staan, en precies een ervan is de actieve.
      const tabs = (markup.match(/class="ax-tab"/g) || []).length;
      const actief = (markup.match(/aria-current="page"/g) || []).length;
      if (tabs !== 5) fouten.push(`${tabs} tabs i.p.v. 5`);
      if (actief !== 1) fouten.push(`${actief} actieve tabs i.p.v. 1`);
      // De gedeelde opmaak moet mee zijn gekomen.
      if (!html.includes('.ax-tab[aria-current')) fouten.push('admin-styles ontbreekt');
      if (!html.includes('class="container ax-page"')) fouten.push('ax-page-romp ontbreekt');
      // De terugknop, met NAAM en al. Robin zag op 16-8 dat hij van grootte
      // verschilde: drie pagina's hadden ax-btn en twee de globale btn, en dat
      // scheelt 10px hoogte en een andere radius. Dit is de regel die dat
      // vasthoudt -- de klasse staat er letterlijk in, want juist zo'n verschil
      // ziet er in de bron uit als hetzelfde.
      const terug = /<a href="\/admin" class="([^"]+)">/.exec(markup);
      if (!terug) fouten.push('geen terugknop naar /admin');
      else if (terug[1] !== 'ax-btn') fouten.push('terugknop heeft class="' + terug[1] + '" i.p.v. ax-btn');
      // Twee vormen van stille schade die er goed uitzien in de bron.
      if (markup.includes("[object Promise]")) fouten.push('onopgeloste include');
      if (html.includes('aria-current=&quot;')) fouten.push('aria-current is ge-escaped');
      if (/undefined/.test(markup)) fouten.push('letterlijke "undefined" in de uitvoer');

      if (fouten.length) { stuk++; console.log(`STUK ${naam} (${label}): ${fouten.join(' · ')}`); }
      else console.log(`OK   ${naam} (${label})  ${html.length} tekens`);
    } catch (e) {
      stuk++;
      console.log(`STUK ${naam} (${label}): ${e.message.split('\n')[0]}`);
    }
  }
}
console.log(stuk ? `\n${stuk} stuk` : '\nalles rendert');
process.exit(stuk ? 1 : 0);
