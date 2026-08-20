/**
 * De leesweergave: tikken op een bericht opent dat bericht.
 *
 * Dit was een heel scherm met een eigen route, dat zijn buren zelf ophaalde, de
 * scrollpositie corrigeerde bij invoegen en de balken wegschoof. Dat is allemaal
 * weg, en dat is winst: Lezen is nu een DERDE WEERGAVE van de feed
 * (body[data-feed-view="reader"]), naast Tijdlijn en Grid. De feed levert de
 * berichten al, "meer laden" vult al aan, en het snappen naar berichtgrenzen
 * doet CSS. Wat overblijft is dit ene gemak.
 *
 * De titel en de voetlink in read-article.ejs zijn echte <a>'s en doen het werk
 * voor toetsenbord en schermlezer; dit hier is er voor een duim.
 *
 * Vier uitzonderingen, want een tik die je niet bedoelde is erger dan geen tik:
 * iets dat zelf al een doel heeft (link, knop, veld) houdt zijn eigen werking,
 * een geselecteerde tekst is geen tik, een verschoven vinger is scrollen, en
 * cmd/ctrl-klik hoort de browser zelf af te handelen.
 */

/**
 * Snappen alleen waar het HELPT.
 *
 * Elk bericht heeft scroll-snap-align:start en min-height:100svh. Voor een kort
 * bericht is dat precies goed: het vult het scherm en de volgende klikt netjes
 * op zijn plek. Voor een LANG bericht is het een val -- je leest naar beneden en
 * de browser trekt je terug naar de bovenrand, waardoor het scrollen lijkt te
 * stoppen terwijl je gewoon doorscrollt. Barts melding (20-8).
 *
 * "Past dit bericht op het scherm?" is een vraag over gemeten hoogte, en die kan
 * CSS niet stellen -- vandaar hier. Past het niet, dan gaat de snap eraf en lees
 * je ononderbroken door tot het volgende bericht wel weer een snappunt is.
 *
 * De marge van 4px vangt afrondingsverschillen tussen svh en de echte hoogte;
 * zonder die speling wipt een bericht dat toevallig exact past heen en weer.
 */
/**
 * Wanneer is de bovenkant van een bericht een snappunt?
 *
 * Alleen zolang je er nog NIET voorbij bent. Zit de bovenrand op of onder de
 * bovenkant van het scherm, dan kom je er nog aan en mag hij vangen. Is hij
 * eenmaal voorbij -- je leest in het bericht -- dan gaat de snap eraf.
 *
 * Robins formulering (20-8), en die is preciezer dan wat ik er eerst van maakte:
 * "in de post zelf mag er nooit gesnapt worden, ook niet bovenin; enkel de
 * onderkant mag snappen naar de volgende post, dus daar de bovenkant van".
 * Precies dat: de onderkant van bericht N is de bovenkant van N+1, en die is een
 * doelwit omdat je hem nadert. De bovenkant van het bericht waar je IN zit is
 * dat niet meer, want daar ben je voorbij.
 *
 * Zonder deze regel trok proximity je terug naar de bovenrand zodra je een paar
 * regels verder scrolde, en leek het of het scrollen vastliep.
 *
 * De 4px is speling voor afronding: tijdens het snappen zelf loopt top naar 0 en
 * mag hij niet halverwege afhaken.
 */
const SPELING = 4;

/**
 * En snappen doet alleen mee op de weg NAAR BENEDEN (Robin, 20-8).
 *
 * Omhoog scroll je om iets terug te zoeken, en dan is elke vangst een hindernis:
 * je wilt zelf bepalen waar je stopt. Omlaag lees je door, en dan helpt de
 * grens juist. Dus bij omhoog gaat de snap er overal af.
 *
 * De drempel van 2px is er tegen richtingsruis: tijdens een vloeiende snap
 * schommelt scrollY een fractie, en zonder speling zou de richting dan heen en
 * weer klappen -- precies midden in de beweging die net soepel moest zijn.
 */
let laatsteY = 0;
let omlaag = true;

/**
 * Hoe DICHT bij de grens hij vangt: de onderste VANGZONE pixels van een bericht.
 *
 * In pixels, en bewust niet inhoudelijk. Ik probeerde het aan de voet van het
 * bericht te hangen ("ben je de reacties voorbij"), maar bij een KORT bericht
 * gaat dat mis: min-height rekt zo'n bericht tot een vol scherm, dus de voet
 * staat middenin met lege ruimte eronder en de zone begint op een willekeurige
 * plek. Robin ving dat (20-8) voordat het uitgerold stond.
 *
 * Eerst stond dit op 20px en dat was te krap om ooit te vangen. Honderdvijftig
 * is ruwweg het laatste stukje van een bericht: kom je daarbinnen tot stilstand,
 * dan trekt hij de streep recht naar de bovenkant van het volgende. Stop je
 * eerder, dan blijf je gewoon staan.
 *
 * Eén getal, dus makkelijk bij te stellen als het onder een duim anders voelt.
 */
const VANGZONE = 150;

function ijkEen(art) {
  const top = art.getBoundingClientRect().top;
  // Omhoog: nooit. Omlaag: alleen een grens die je NADERT en die binnen de zone
  // ligt. De ondergrens blijft krap (SPELING): eenmaal voorbij wordt er niet
  // teruggetrokken, ook niet over een paar pixels.
  const wil = (!omlaag || top < -SPELING || top > VANGZONE) ? 'none' : '';
  // Alleen aanraken als het echt verandert: elke stijlwijziging tijdens een
  // vloeiende scroll is een kans op een hik, zeker op iOS.
  if (art.style.scrollSnapAlign !== wil) art.style.scrollSnapAlign = wil;
}

function ijkSnappen() {
  const y = window.scrollY;
  if (Math.abs(y - laatsteY) > 2) omlaag = y > laatsteY;
  laatsteY = y;
  document.querySelectorAll('.feed-reader .read-post').forEach(ijkEen);
}

/**
 * Terug naar boven, en bewust NIET window.scrollTo(0).
 *
 * In een stroom wil je terug naar het BEGIN VAN DIT BERICHT als je halverwege een
 * lang stuk zit, en pas daarna naar de kop van de pagina. Twee keer drukken doet
 * dus twee verschillende dingen -- dat scheelt op mobiel een halve minuut vegen.
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
  const s = document.getElementById('read-stream');
  if (!s) return;
  // Op de stroom, niet per artikel: wat "meer laden" erbij zet doet vanzelf mee.
  // init() draait bij ELKE paginawissel, dus eerst losmaken -- anders stapelt
  // dezelfde afhandelaar zich op en vuurt hij twee keer.
  s.removeEventListener('pointerdown', onPointerDown);
  s.removeEventListener('click', onTap);
  s.addEventListener('pointerdown', onPointerDown, { passive: true });
  s.addEventListener('click', onTap);

  // De knop staat in de HTML (read-top.ejs), zodat hij er ook is zonder deze
  // module -- dan doet hij niets, maar hij springt niet in beeld bij het laden.
  knop = document.getElementById('read-top');
  if (knop) {
    knop.onclick = naarBoven;
    toonKnop(knop);
  }

  // Eén luisteraar, en losmaken bij een volgende init(): deze module draait bij
  // ELKE paginawissel en anders stapelen ze op.
  if (opScroll) {
    window.removeEventListener('scroll', opScroll);
    window.removeEventListener('resize', opScroll);
  }
  // Eén keer per frame, niet per scroll-event: scroll vuurt tientallen keren per
  // seconde en we raken hier de stijl van elk bericht aan.
  let gepland = false;
  opScroll = () => {
    if (knop) toonKnop(knop);
    if (gepland) return;
    gepland = true;
    requestAnimationFrame(() => { gepland = false; ijkSnappen(); });
  };
  window.addEventListener('scroll', opScroll, { passive: true });
  window.addEventListener('resize', opScroll, { passive: true });
  ijkSnappen();   // ook meteen bij binnenkomst, niet pas bij de eerste scroll
}

export default { init };
