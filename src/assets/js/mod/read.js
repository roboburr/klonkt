/**
 * De leesweergave: tikken op een bericht opent dat bericht, en een knop om terug
 * naar boven te gaan.
 *
 * Dit was een heel scherm met een eigen route, dat zijn buren zelf ophaalde, de
 * scrollpositie corrigeerde bij invoegen en de balken wegschoof. Dat is allemaal
 * weg, en dat is winst: Lezen is nu een WEERGAVE van de feed
 * (body[data-feed-view="reader"]), naast Tijdlijn en Grid. De feed levert de
 * berichten al en "meer laden" vult al aan.
 *
 * GEWOON SCROLLEN (Robin, 30-9: "Reader view normaal scrollen, Lenis mag helemaal
 * uit klonkt"). Hier stond Lenis: op desktop voor zacht scrollen en snappen naar
 * de bovenkant van een bericht, op mobiel nam hij de vinger over en bootsten we
 * het snappen na. Dat is er allemaal uit. De browser scrolt, zoals op elke andere
 * pagina, en er snapt niets meer. Waarom snappen niet native terugkwam, en hoe
 * dat alsnog zou kunnen, staat in de vault onder "Klonkt Reader Scroll".
 *
 * De titel en de voetlink in read-article.ejs zijn echte <a>'s en doen het werk
 * voor toetsenbord en schermlezer; de tik hieronder is er voor een duim.
 *
 * Vier uitzonderingen op die tik, want een tik die je niet bedoelde is erger dan
 * geen tik: iets dat zelf al een doel heeft (link, knop, veld) houdt zijn eigen
 * werking, een geselecteerde tekst is geen tik, een verschoven vinger is
 * scrollen, en cmd/ctrl-klik hoort de browser zelf af te handelen.
 */

const OP_TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)');

// ── Paginamodus ─────────────────────────────────────────────────────────────
/**
 * PAGINAMODUS STAAT UIT -- maar de code blijft staan (Robin, 20-8: "weghalen
 * maar bewaren, voor als ik het later weer wil").
 *
 * Wat het is: elk bericht een paneel van een scherm dat zelf scrollt, met twee
 * balken om ertussen te navigeren. Gebouwd omdat het namaken van iOS-momentum
 * niet lukte; in dit model doet het scrollgevoel er namelijk niet toe.
 *
 * Sinds Lenis weg is (30-9) zet de CSS de stroom vast in plaats van lenis.stop()
 * (html:has(body.is-paged) in style.css), en gaan de balken met native
 * scrollIntoView. Niet uitgeprobeerd sinds die omzetting, want de modus staat
 * uit: wie hem aanzet, kijkt dat eerst na.
 *
 * Aanzetten: deze constante op true. Dan komen de balken terug (CSS hangt aan
 * body.is-paged) en scrollen de panelen zelf.
 */
const PAGINAMODUS = false;

function paginaModus() {
  return PAGINAMODUS && OP_TOUCH.matches && document.body.dataset.feedView === 'reader';
}

function panelen() {
  return [...document.querySelectorAll('.feed-reader .read-post')];
}

/** Welk paneel vult nu het scherm? Het eerste waarvan de bovenkant niet voorbij is. */
function huidigIndex() {
  const P = panelen();
  for (let i = 0; i < P.length; i++) {
    if (P[i].getBoundingClientRect().top > 8) return Math.max(0, i - 1);
  }
  return Math.max(0, P.length - 1);
}

function gaNaar(i) {
  const P = panelen();
  const doel = P[Math.max(0, Math.min(P.length - 1, i))];
  if (!doel) return;
  doel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(zetBalken, 80);
}

/**
 * Omhoog vanaf het EERSTE bericht brengt je naar de header.
 *
 * In paginamodus scrolt de stroom niet met je vinger, dus dan is alles boven het
 * eerste bericht onbereikbaar. Robin liep daar tegenaan (20-8): "ik kan niet
 * meer terug scrollen naar de header". De omhoog-knop is daar de enige weg
 * naartoe, dus die krijgt er een trede bij.
 */
function gaOmhoog() {
  const i = huidigIndex();
  if (i > 0) { gaNaar(i - 1); return; }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * Welke balk hoort er te staan? Bovenaan de pagina is er niets boven je, dus dan
 * geen bovenbalk. Buiten paginamodus staan ze allebei niet -- de CSS verbergt ze
 * daar al, maar hidden houdt ze ook uit de toetsenbordvolgorde.
 */
function zetBalken() {
  const boven = document.getElementById('read-prev');
  const onder = document.getElementById('read-next-nav');
  const aan = paginaModus();
  // De bovenbalk hoort NOOIT over de header te liggen. Hij verscheen al zodra je
  // een paar pixels scrolde, en dekte dan de avatar, de omschrijving en de
  // weergaveknoppen af (Robins schermafbeelding, 20-8). Nu komt hij pas als het
  // eerste bericht de bovenrand van het scherm heeft bereikt -- dan is de header
  // voorbij en is er ook echt iets om naar terug te gaan.
  const eerste = panelen()[0];
  const headerNogInBeeld = eerste ? eerste.getBoundingClientRect().top > 4 : true;
  if (boven) boven.hidden = !aan || headerNogInBeeld;
  if (onder) onder.hidden = !aan;
  if (onder && aan) onder.style.bottom = onderChroom() + 'px';
}

/**
 * Hoe hoog staat de onderrand van het scherm werkelijk vol?
 *
 * De onderbalk stond op een geraden 4.75rem boven de onderkant, en dan zweeft
 * hij: soms een kier boven de speler, soms er half achter. De tabbalk en de
 * mini-speler hebben allebei een eigen hoogte, ze stapelen op mobiel, en de
 * speler komt en gaat. Dus meten in plaats van gokken: hoe ver ligt de BOVENKANT
 * van het hoogste vaste element boven de onderrand van het venster?
 */
function onderChroom() {
  // .bottom-tab-fab staat erbij omdat de Write-knop BOVEN de tabbalk uitsteekt:
  // meet je alleen de balk, dan legt onze balk zich over die knop heen (Robins
  // schermafbeelding, 20-8).
  const kandidaten = ['.bottom-tab', '.bottom-tab-fab', '#pcms-audio-player'];
  let hoogste = 0;
  kandidaten.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.height <= 0) return;
    hoogste = Math.max(hoogste, window.innerHeight - r.top);
  });
  return Math.round(hoogste);
}

function pasPaginaModusToe() {
  document.body.classList.toggle('is-paged', paginaModus());
  zetBalken();
}

/**
 * Terug naar boven, en bewust NIET meteen window.scrollTo(0).
 *
 * In een stroom wil je terug naar het BEGIN VAN DIT BERICHT als je halverwege een
 * lang stuk zit, en pas daarna naar de kop van de pagina. Twee keer drukken doet
 * dus twee verschillende dingen -- dat scheelt op mobiel een hoop vegen.
 */
function naarBoven() {
  const zacht = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const gedrag = zacht ? 'smooth' : 'auto';
  const posts = [...document.querySelectorAll('.feed-reader .read-post')];
  const huidig = posts.find((a) => {
    const r = a.getBoundingClientRect();
    return r.top <= 8 && r.bottom > 8;
  });
  // Sta je al bovenaan dit bericht (of bij het eerste), dan naar de paginakop.
  if (huidig && huidig.getBoundingClientRect().top < -8) {
    huidig.scrollIntoView({ behavior: gedrag, block: 'start' });
    return;
  }
  window.scrollTo({ top: 0, behavior: gedrag });
}

/** De knop verschijnt pas als er iets ONDER je ligt om naar terug te keren. */
function toonKnop(knop) {
  knop.classList.toggle('is-zichtbaar', window.scrollY > window.innerHeight * 0.6);
}

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

let knop = null;
let opScroll = null;

export function init() {
  // EERST OPRUIMEN, en pas daarna terugvallen als er geen leesstroom is. init()
  // draait bij elke paginawissel, en wat de leesweergave aanzette hoort weg te
  // zijn zodra je hem verlaat -- ook op pagina's die met Lezen niets te maken
  // hebben (Robins melding van 20-8, toen dat misging: "scrollen werkt nu nergens
  // ook niet in admin panels").
  document.body.classList.remove('is-paged');
  // Een tabblad dat nog met de vorige versie van deze module is geopend, heeft
  // het native snappen inline uitgezet. Na een htmx-wissel naar deze versie hoort
  // daar niets van over te blijven.
  document.documentElement.style.scrollSnapType = '';

  const s = document.getElementById('read-stream');
  if (!s) return;
  // Op de stroom, niet per artikel: wat "meer laden" erbij zet doet vanzelf mee.
  // init() draait bij ELKE paginawissel, dus eerst losmaken -- anders stapelt
  // dezelfde afhandelaar zich op en vuurt hij twee keer.
  s.removeEventListener('pointerdown', onPointerDown);
  s.removeEventListener('click', onTap);
  s.addEventListener('pointerdown', onPointerDown, { passive: true });
  s.addEventListener('click', onTap);

  // De knop staat in de HTML, zodat hij er ook is zonder deze module -- dan doet
  // hij niets, maar hij springt niet in beeld bij het laden.
  // De terug-naar-boven-knop staat er tijdelijk uit (Robin, 20-8) -- in
  // paginamodus doet de bovenbalk dat werk al. De code blijft staan zodat hij
  // met een regel terug is.
  knop = null;
  const oudeKnop = document.getElementById('read-top');
  if (oudeKnop) oudeKnop.hidden = true;

  if (opScroll) {
    window.removeEventListener('scroll', opScroll);
    window.removeEventListener('resize', opScroll);
  }
  opScroll = () => {
    if (knop) toonKnop(knop);
    if (document.body.classList.contains('is-paged')) zetBalken();
  };
  window.addEventListener('scroll', opScroll, { passive: true });
  window.addEventListener('resize', opScroll, { passive: true });

  const balkBoven = document.getElementById('read-prev');
  const balkOnder = document.getElementById('read-next-nav');
  if (balkBoven) balkBoven.onclick = gaOmhoog;
  if (balkOnder) balkOnder.onclick = () => gaNaar(huidigIndex() + 1);

  pasPaginaModusToe();
}

export default { init };
