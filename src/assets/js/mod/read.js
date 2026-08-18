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
 *
 * De namen hieronder zijn Engels, zoals overal in assets/js/mod. Het commentaar
 * blijft Nederlands, zoals overal in deze repo.
 */

// Hoeveel schermen vooruit we alvast halen. Eén is genoeg: je leest niet
// sneller dan je scrolt, en meer betekent alleen meer verkeer.
const ROOT_MARGIN = '1px 0px 100% 0px';

// De teksten die dit script plaatst. Ze staan in data-i18n op de stroom, want
// een zin die hier staat, staat in één taal -- en dat is nooit de taal van de
// lezer. Zelfde afspraak als de topnav (mod/chrome.js).
let strings = {};
function str(key) { return strings[key] || ''; }

const stream = () => document.getElementById('read-stream');
const loaded = new Set();       // slugs die al in de stroom staan
let busyBelow = false;
let busyAbove = false;
let observer = null;
let lastY = 0;

// Niet `chrome`: dat is in deze browser ook een global, en een module-scope die
// window.chrome overschaduwt is een val voor de volgende lezer.
function toggleChrome(hide) {
  document.body.classList.toggle('read-chrome-hidden', !!hide);
}

/** Het artikel dat nu het meest in beeld is; die bepaalt titel en URL. */
function inView() {
  const posts = [...document.querySelectorAll('.read-post')];
  const middle = window.innerHeight / 2;
  return posts.find((p) => {
    const r = p.getBoundingClientRect();
    return r.top <= middle && r.bottom >= middle;
  }) || posts[0];
}

/** Titel en adres volgen wat je leest. replaceState: je bladert, je stapelt niet. */
function syncAddress() {
  const p = inView();
  if (!p) return;
  const slug = p.dataset.slug;
  const base = p.dataset.base || '';
  if (location.pathname === `${base}/read/${slug}`) return;
  history.replaceState(null, '', `${base}/read/${slug}`);
  if (p.dataset.title) document.title = p.dataset.title;
}

async function fetchArticle(slug, base) {
  const r = await fetch(`${base}/read/${encodeURIComponent(slug)}?fragment=1`, {
    headers: { 'HX-Request': 'true' },
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const box = document.createElement('div');
  box.innerHTML = await r.text();
  const art = box.querySelector('.read-post');
  if (!art) throw new Error('no post in the response');
  return art;
}

/** Onderaan aanvullen: gewoon erbij zetten, de scrollpositie verandert niet. */
async function appendOlder() {
  const s = stream();
  if (!s || busyBelow) return;
  const last = s.querySelector('.read-post:last-of-type');
  const slug = last && last.dataset.older;
  if (!slug) return markEnd(s);
  if (loaded.has(slug)) return;
  busyBelow = true;
  const pending = notice(s, 'read-loading', '…');
  try {
    const art = await fetchArticle(slug, last.dataset.base || '');
    loaded.add(slug);
    pending.remove();
    s.appendChild(art);
    watch();
  } catch (e) {
    pending.textContent = str('load_error');
    console.warn('[read] below:', e && e.message);
  } finally { busyBelow = false; }
}

/**
 * Bovenaan aanvullen. Dit is het enige plek waar we de scrollpositie WEL
 * moeten bijstellen: er komt hoogte bij bóven het beeld, en zonder correctie
 * schuift alles wat je las naar beneden weg. We meten de hoogte na het invoegen
 * en tellen die bij de scrollpositie op -- geen animatie, geen sprong.
 */
async function prependNewer() {
  const s = stream();
  if (!s || busyAbove) return;
  const first = s.querySelector('.read-post');
  const slug = first && first.dataset.newer;
  if (!slug || loaded.has(slug)) return;
  busyAbove = true;
  const root = document.documentElement;
  try {
    const art = await fetchArticle(slug, first.dataset.base || '');
    loaded.add(slug);
    // Snappen even UIT. De correctie hieronder zet de scrollpositie precies
    // goed, maar een proximity-snap trekt hem daarna alsnog naar de grens van
    // het bericht dat er net bij kwam -- gemeten: een sprong ter grootte van
    // dat hele bericht, precies de ruk die deze opzet moet vermijden.
    root.style.scrollSnapType = 'none';
    const before = s.scrollHeight;
    s.insertBefore(art, first);
    const added = s.scrollHeight - before;
    window.scrollBy(0, added);
    watch();
    // Twee frames: één om de correctie te laten landen, één om te snappen pas
    // weer toe te staan als de browser klaar is met deze scroll.
    requestAnimationFrame(() => requestAnimationFrame(() => { root.style.scrollSnapType = ''; }));
  } catch (e) {
    root.style.scrollSnapType = '';
    console.warn('[read] above:', e && e.message);
  } finally { busyAbove = false; }
}

function notice(s, className, text) {
  const d = document.createElement('div');
  d.className = className;
  d.textContent = text;
  s.appendChild(d);
  return d;
}

function markEnd(s) {
  if (s.querySelector('.read-end')) return;
  notice(s, 'read-end', str('end'));
}

/** (Her)richt de waarnemer op de huidige eerste en laatste post. */
function watch() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      // GEEN else-if. Bij het laden staat er één artikel in de stroom, en dat is
      // tegelijk het eerste én het laatste. Met een else-if wint de eerste tak
      // altijd, en dan draait prependNewer() nooit: wie op het OUDSTE bericht
      // binnenkomt, krijgt "einde archief" te zien terwijl er zes nieuwere
      // boven hem staan die hij nooit te pakken krijgt.
      if (e.target.matches('.read-post:last-of-type')) appendOlder();
      if (e.target.matches('.read-post:first-of-type')) prependNewer();
    }
  }, { rootMargin: ROOT_MARGIN });
  const first = stream() && stream().querySelector('.read-post');
  const last = stream() && stream().querySelector('.read-post:last-of-type');
  if (first) observer.observe(first);
  if (last && last !== first) observer.observe(last);
}

/**
 * Tikken op een bericht opent dat bericht.
 *
 * De stroom toont de tekst; het gesprek -- reacties, waarderingen, boosts --
 * staat op de berichtpagina. De titel en de voetlink zijn echte <a>'s en doen
 * het werk voor toetsenbord en schermlezer; dit hier is het gemak voor een duim.
 *
 * Daarom vier uitzonderingen, want een tik die je niet bedoelde is erger dan
 * geen tik: iets dat zelf al een doel heeft (link, knop, veld) houdt zijn eigen
 * werking, een geselecteerde tekst is geen tik, een verschoven vinger is
 * scrollen, en cmd/ctrl-klik hoort de browser zelf af te handelen.
 */
let tapX = 0, tapY = 0;
function onPointerDown(e) { tapX = e.clientX; tapY = e.clientY; }

function onTap(e) {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  const art = t.closest('.read-post');
  if (!art) return;
  if (t.closest('a, button, input, textarea, select, label, summary, [role="button"]')) return;
  if (Math.abs(e.clientX - tapX) > 10 || Math.abs(e.clientY - tapY) > 10) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && String(sel).trim()) return;
  const slug = art.dataset.slug;
  if (!slug) return;
  location.href = (art.dataset.base || '') + '/' + encodeURIComponent(slug);
}

function onScroll() {
  const y = window.scrollY || 0;
  if (y < 8) toggleChrome(false);
  else if (y > lastY + 4) toggleChrome(true);
  else if (y < lastY - 24) toggleChrome(false);
  lastY = y;
  syncAddress();
}

export function init() {
  const s = stream();
  if (!s) return;
  try { strings = JSON.parse(s.getAttribute('data-i18n') || '{}'); } catch (e) { strings = {}; }
  s.querySelectorAll('.read-post').forEach((p) => loaded.add(p.dataset.slug));
  lastY = window.scrollY || 0;
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', watch, { passive: true });
  // Op de stroom, niet per artikel: aangevulde berichten doen zo vanzelf mee.
  s.addEventListener('pointerdown', onPointerDown, { passive: true });
  s.addEventListener('click', onTap);
  watch();
}

export default { init };
