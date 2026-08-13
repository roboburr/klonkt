// De SEO-pagina: op dit moment alleen het MusicBrainz-paneel (shaer-mbz).
//
// De rest van dit scherm is gewone formuliervelden en heeft geen JavaScript
// nodig; deze module bestaat omdat opzoeken dat wel doet.

import { pageData, makeSweeper } from './lib.js';

const doc = makeSweeper();
let T = {};

export function init() {
  doc.sweep();
  T = pageData();
  run();
}

function run() {
  // Binnen run() en niet op moduleniveau: deze modules krijgen bij elke
  // paginawissel opnieuw init(), en een blok dat maar een keer per sessie
  // draait is precies wat shaer-5s1 opleverde.
  wireMusicBrainz();
}

/**
 * "Zoek jezelf op" in MusicBrainz.
 *
 * De kandidaten komen van de server, want MusicBrainz eist een verzoek per
 * seconde per APPLICATIE en een User-Agent met contact -- allebei niet vanuit
 * een browser af te dwingen.
 *
 * WIJ KIEZEN NIET. Ook niet als er precies een treffer is: een verkeerd geraden
 * MBID zet jouw naam onder andermans werk. De knop staat er, de klik is van de
 * artiest. En de keuze gaat mee met de Opslaan van de pagina -- een eigen
 * formulier kan hier niet, want deze pagina IS er een.
 */
function wireMusicBrainz() {
  const knop = document.getElementById('mb-zoek-btn');
  const veld = document.getElementById('mb-q');
  const uit = document.getElementById('mb-uit');
  const idVeld = document.getElementById('mb-id');
  const naamVeld = document.getElementById('mb-naam');
  const huidig = document.getElementById('mb-huidig');
  if (!knop || !veld || !uit || !idVeld || knop.__wired) return;
  knop.__wired = true;

  const el = (tag, cls, tekst) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    // textContent en nooit innerHTML: dit is tekst uit een vreemd register.
    if (tekst != null) e.textContent = tekst;
    return e;
  };

  function zet(mbid, naam) {
    idVeld.value = mbid || '';
    if (naamVeld) naamVeld.value = naam || '';
    if (huidig) {
      huidig.hidden = !mbid;
      const n = document.getElementById('mb-huidig-naam');
      const a = document.getElementById('mb-huidig-link');
      if (n) n.textContent = naam || mbid || '';
      if (a) a.href = mbid ? `https://musicbrainz.org/artist/${mbid}` : '#';
    }
    uit.hidden = true;
    uit.replaceChildren();
    checkTerugweg(mbid);
  }

  const wis = document.getElementById('mb-wis');
  if (wis) wis.addEventListener('click', () => zet('', ''));

  // DE TERUG-WEG. Wij zetten hem niet -- dat kan niet via hun API en hoort ook
  // niet -- we kijken alleen of de artiestenpagina ons domein noemt. Zolang dat
  // niet zo is staat er "nog eenzijdig", want een halve koppeling die als
  // bevestigd leest is het soort stilte waar we vandaag al genoeg van zagen.
  const terugweg = document.getElementById('mb-terugweg');
  async function checkTerugweg(mbid) {
    if (!terugweg) return;
    if (!mbid) { terugweg.hidden = true; terugweg.textContent = ''; return; }
    terugweg.hidden = false;
    terugweg.className = 'mb-terugweg';
    terugweg.textContent = T.aseo_mb_checking || 'Terug-weg controleren…';
    try {
      const r = await fetch(`/admin/seo/api/musicbrainz/terugweg?mbid=${encodeURIComponent(mbid)}`, { credentials: 'same-origin' });
      const j = await r.json();
      terugweg.className = 'mb-terugweg ' + (j.verified ? 'is-ok' : 'is-eenzijdig');
      terugweg.textContent = j.verified
        ? (T.aseo_mb_verified || 'Wederzijds.')
        : (T.aseo_mb_unverified || 'Nog eenzijdig.');
    } catch {
      terugweg.hidden = true;
    }
  }
  // Meteen bij het openen, want de artiest kan hem intussen op MusicBrainz
  // hebben gezet en hoort dat hier te zien zonder opnieuw te koppelen.
  if (idVeld.value) checkTerugweg(idVeld.value);

  async function zoek() {
    const q = (veld.value || '').trim();
    if (!q) return;
    uit.hidden = false;
    uit.replaceChildren(el('p', 'form-hint', T.aseo_mb_busy || 'Zoeken…'));
    knop.disabled = true;
    try {
      const r = await fetch(`/admin/seo/api/musicbrainz?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const j = await r.json();
      toon((j && j.kandidaten) || []);
    } catch {
      uit.replaceChildren(el('p', 'form-hint', T.aseo_mb_fail || 'MusicBrainz is even niet bereikbaar.'));
    } finally {
      knop.disabled = false;
    }
  }

  function toon(kandidaten) {
    if (!kandidaten.length) {
      uit.replaceChildren(el('p', 'form-hint', T.aseo_mb_none || 'Niets gevonden.'));
      return;
    }
    const lijst = el('ul', 'mb-lijst');
    for (const k of kandidaten) {
      const li = el('li', 'mb-kandidaat');
      li.appendChild(el('strong', null, k.naam));
      // De toelichting is het hele punt: er zijn drie bands die Nirvana heten,
      // en zonder dit veld kiest iemand de verkeerde.
      const bij = [k.toelichting, k.soort, k.land, k.jaren].filter(Boolean).join(' · ');
      if (bij) li.appendChild(el('small', 'mb-bij', bij));
      const open = el('a', 'mb-open', T.aseo_mb_open || 'Bekijk op MusicBrainz');
      open.href = k.url; open.target = '_blank'; open.rel = 'noopener';
      li.appendChild(open);
      const b = el('button', 'btn', T.aseo_mb_pick || 'Dit ben ik');
      b.type = 'button';
      b.addEventListener('click', () => zet(k.mbid, k.naam));
      li.appendChild(b);
      lijst.appendChild(li);
    }
    uit.replaceChildren(lijst);
  }

  knop.addEventListener('click', zoek);
  veld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); zoek(); } });
}
