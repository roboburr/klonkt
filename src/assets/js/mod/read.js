/**
 * De leesweergave: een stroom van hele berichten, één per beeld.
 *
 * NIET de truc van bartoverkamp.nl. Daar springt de pagina bij de rand naar de
 * andere kant en wordt het nieuwe artikel "vloeiend" in beeld gezet -- een naad
 * die verborgen wordt. Hier groeit de stroom in de richting waarin je leest:
 * bij de onderrand komt de oudere buur eronder te staan, bij de bovenrand de
 * nieuwere erboven. De browser snapt naar de berichtgrenzen (CSS, proximity).
 * Er is dan geen naad, dus ook niets te verbergen.
 *
 * Elk artikel draagt zijn eigen buren in data-attributen. Wat er nog te halen
 * valt staat dus altijd op het stuk dat er al is, en deze module hoeft geen
 * lijst bij te houden die uit de pas kan lopen.
 */

// Hoeveel schermen vooruit we alvast halen. Eén is genoeg: je leest niet
// sneller dan je scrolt, en meer betekent alleen meer verkeer.
const MARGE = '1px 0px 100% 0px';

// De teksten die dit script plaatst. Ze staan in data-i18n op de stroom, want
// een zin die hier staat, staat in één taal -- en dat is nooit de taal van de
// lezer. Zelfde afspraak als de topnav (mod/chrome.js).
let woorden = {};
function woord(sleutel) { return woorden[sleutel] || ''; }

const stroom = () => document.getElementById('read-stream');
const geladen = new Set();      // slugs die al in de stroom staan
let bezigOnder = false;
let bezigBoven = false;
let waarnemer = null;
let laatsteY = 0;

function chrome(verbergen) {
  document.body.classList.toggle('read-chrome-hidden', !!verbergen);
}

/** Het artikel dat nu het meest in beeld is; die bepaalt titel en URL. */
function inBeeld() {
  const posts = [...document.querySelectorAll('.read-post')];
  const midden = window.innerHeight / 2;
  return posts.find((p) => {
    const r = p.getBoundingClientRect();
    return r.top <= midden && r.bottom >= midden;
  }) || posts[0];
}

/** Titel en adres volgen wat je leest. replaceState: je bladert, je stapelt niet. */
function volgAdres() {
  const p = inBeeld();
  if (!p) return;
  const slug = p.dataset.slug;
  const basis = p.dataset.base || '';
  if (location.pathname === `${basis}/read/${slug}`) return;
  history.replaceState(null, '', `${basis}/read/${slug}`);
  if (p.dataset.title) document.title = p.dataset.title;
}

async function haal(slug, basis) {
  const r = await fetch(`${basis}/read/${encodeURIComponent(slug)}?partial=1`, {
    headers: { 'HX-Request': 'true' },
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const doos = document.createElement('div');
  doos.innerHTML = await r.text();
  const art = doos.querySelector('.read-post');
  if (!art) throw new Error('geen bericht in het antwoord');
  return art;
}

/** Onderaan aanvullen: gewoon erbij zetten, de scrollpositie verandert niet. */
async function vulAan() {
  const s = stroom();
  if (!s || bezigOnder) return;
  const laatste = s.querySelector('.read-post:last-of-type');
  const slug = laatste && laatste.dataset.older;
  if (!slug) return klaar(s);
  if (geladen.has(slug)) return;
  bezigOnder = true;
  const wacht = melding(s, 'read-loading', '…');
  try {
    const art = await haal(slug, laatste.dataset.base || '');
    geladen.add(slug);
    wacht.remove();
    s.appendChild(art);
    kijk();
  } catch (e) {
    wacht.textContent = woord('load_error');
    console.warn('[read] onderaan:', e && e.message);
  } finally { bezigOnder = false; }
}

/**
 * Bovenaan aanvullen. Dit is het enige plek waar we de scrollpositie WEL
 * moeten bijstellen: er komt hoogte bij bóven het beeld, en zonder correctie
 * schuift alles wat je las naar beneden weg. We meten de hoogte na het invoegen
 * en tellen die bij de scrollpositie op -- geen animatie, geen sprong.
 */
async function vulAanBoven() {
  const s = stroom();
  if (!s || bezigBoven) return;
  const eerste = s.querySelector('.read-post');
  const slug = eerste && eerste.dataset.newer;
  if (!slug || geladen.has(slug)) return;
  bezigBoven = true;
  try {
    const art = await haal(slug, eerste.dataset.base || '');
    geladen.add(slug);
    const voor = s.scrollHeight;
    s.insertBefore(art, eerste);
    const erbij = s.scrollHeight - voor;
    window.scrollBy(0, erbij);
    kijk();
  } catch (e) {
    console.warn('[read] bovenaan:', e && e.message);
  } finally { bezigBoven = false; }
}

function melding(s, klasse, tekst) {
  const d = document.createElement('div');
  d.className = klasse;
  d.textContent = tekst;
  s.appendChild(d);
  return d;
}

function klaar(s) {
  if (s.querySelector('.read-end')) return;
  melding(s, 'read-end', woord('end'));
}

/** (Her)richt de waarnemer op de huidige eerste en laatste post. */
function kijk() {
  if (waarnemer) waarnemer.disconnect();
  waarnemer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      if (e.target.matches('.read-post:last-of-type')) vulAan();
      else if (e.target.matches('.read-post:first-of-type')) vulAanBoven();
    }
  }, { rootMargin: MARGE });
  const eerste = stroom() && stroom().querySelector('.read-post');
  const laatste = stroom() && stroom().querySelector('.read-post:last-of-type');
  if (eerste) waarnemer.observe(eerste);
  if (laatste && laatste !== eerste) waarnemer.observe(laatste);
}

function bijScroll() {
  const y = window.scrollY || 0;
  if (y < 8) chrome(false);
  else if (y > laatsteY + 4) chrome(true);
  else if (y < laatsteY - 24) chrome(false);
  laatsteY = y;
  volgAdres();
}

export function init() {
  const s = stroom();
  if (!s) return;
  try { woorden = JSON.parse(s.getAttribute('data-i18n') || '{}'); } catch (e) { woorden = {}; }
  s.querySelectorAll('.read-post').forEach((p) => geladen.add(p.dataset.slug));
  laatsteY = window.scrollY || 0;
  window.addEventListener('scroll', bijScroll, { passive: true });
  window.addEventListener('resize', kijk, { passive: true });
  kijk();
}

export default { init };
