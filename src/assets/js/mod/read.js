/**
 * De leesweergave: tikken op een bericht opent dat bericht, en een knop om terug
 * naar boven te gaan.
 *
 * Dit was een heel scherm met een eigen route, dat zijn buren zelf ophaalde, de
 * scrollpositie corrigeerde bij invoegen en de balken wegschoof. Dat is allemaal
 * weg, en dat is winst: Lezen is nu een WEERGAVE van de feed
 * (body[data-feed-view="reader"]), naast Tijdlijn en Grid. De feed levert de
 * berichten al, "meer laden" vult al aan, en het snappen naar berichtgrenzen
 * doet CSS.
 *
 * HET SNAPPEN STAAT HIER MET OPZET NIET IN. Ik heb dat een ronde lang wel
 * geprobeerd -- richting bijhouden, een vangzone uitrekenen, per scroll-event
 * het snappunt verzetten -- en dat is de verkeerde laag. Robins bezwaar (20-8):
 * "scroll-snap op het element is iets anders dan touch events,
 * requestAnimationFrame etc. dan gaan we te veel van de view doen." Klopt, en
 * het vocht ook met de browser: de scroll-events bevatten OOK de bewegingen van
 * zijn eigen snap-animatie, dus de richting die je eruit afleidt is niet die van
 * de gebruiker.
 *
 * Wat er nodig was, was een regel minder in de CSS en niet honderd erbij hier:
 * zie style.css bij .feed-reader .read-post.
 *
 * De titel en de voetlink in read-article.ejs zijn echte <a>'s en doen het werk
 * voor toetsenbord en schermlezer; de tik hieronder is er voor een duim.
 *
 * Vier uitzonderingen op die tik, want een tik die je niet bedoelde is erger dan
 * geen tik: iets dat zelf al een doel heeft (link, knop, veld) houdt zijn eigen
 * werking, een geselecteerde tekst is geen tik, een verschoven vinger is
 * scrollen, en cmd/ctrl-klik hoort de browser zelf af te handelen.
 */

/**
 * Terug naar boven, en bewust NIET window.scrollTo(0).
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

/**
 * Omhoog scrollen blijft VRIJ (Robin, 20-8).
 *
 * Snappen hoort bij doorlezen; ga je terug, dan zoek je iets en bepaal je zelf
 * waar je stopt. CSS kent geen richtingsgevoelig snappen, dus dat ene stukje
 * moet hier -- maar dan ook niet meer dan dat: we zetten de CSS-functie aan of
 * uit op de scroller. Geen vangzones, geen snappunten per bericht, geen
 * scrollpositie-boekhouding.
 *
 * DE RICHTING KOMT UIT DE INVOER, niet uit scroll-events. Gemeten op dev: die
 * events bevatten ook de bewegingen van de browser zelf -- zijn snap-animatie en
 * de rubber-band -- en die gaan soms omhoog. Wie daaruit de richting afleidt,
 * leest de browser en niet de gebruiker.
 *
 * EN ER WORDT ALLEEN GESCHAKELD BIJ STILSTAND. Dat is de tweede les, en die
 * kostte een ronde. Eerst zette dit de schakelaar om bij ELK wiel-event en ELKE
 * vingerbeweging, dus binnen een veeg klapte hij meerdere keren heen en weer.
 * De browser raadpleegt scroll-snap-type alleen aan het eind van een gebaar of
 * van de uitloop, en of je daar net vóór of net ná zit bepaalt dan of er
 * gesnapt wordt. Gemeten (Robins melding "soms triggert het terwijl we nog aan
 * het doorscrollen zijn"):
 *
 *     snappen UIT, beweging naar 1459 loopt
 *     -> halverwege snappen AAN gezet
 *     -> eindigt op 1459, NIET op een berichtgrens
 *
 * Bij stilstand omzetten is wel onschuldig: dezelfde proef gaf 0px sprong.
 * Vandaar: richting bepalen bij het BEGIN van een gebaar, en daarna niets meer
 * aanraken tot de scroll echt stil is.
 *
 * Wat je daarvoor inlevert: binnen een veeg ligt de stand vast. Draai je
 * halverwege om zonder los te laten, dan geldt de stand van dat gebaar nog. Een
 * besluit per gebaar is voorspelbaar; het omklappen halverwege was het probleem.
 */
const RUST_MS = 120;

let bezig = false;          // loopt er een gebaar of een uitloop?
let rustTimer = null;

/**
 * LENIS, en alleen op desktop.
 *
 * Op touch doet Lenis van zichzelf niets (syncTouch staat standaard uit) en is
 * het systeem-scrollen al soepel -- daar blijft de native CSS-snap staan die
 * hierboven beschreven is. Robins keuze (20-8): "enkel voor desktop, dat is
 * prima, logisch dat het niet op mobiel kan".
 *
 * WAAROM LENIS HIER STAAT, en dat is niet het vloeiende scrollen: de DUUR van
 * een snap is met native scroll-snap niet in te stellen -- die zit in de browser.
 * Lenis' snap-pakket wel: duration, easing, distanceThreshold en debounce zijn
 * allemaal van ons. Dat was de aanleiding.
 *
 * Het vloeiende scrollen (smoothWheel) kwam er daarna bij, en dat is de kant die
 * OPPASSEN vraagt. Een Mac-trackpad heeft zijn EIGEN momentum, en Lenis'
 * demping komt daar bovenop -- dubbel gedempt voelt drijverig. Vandaar lerp 0.2
 * in plaats van de standaard 0.1. Robin vond dat op 20-8 nog steeds te zweverig,
 * dus dat getal is nog niet uit; zie de opmerking bij de instellingen.
 *
 * De stand met `smoothWheel: false` werkte ook, en dan doet Lenis alleen de
 * snap. Dat is de terugvalpositie als het vloeiende scrollen niet bevalt.
 *
 * lenis/snap haakt alleen in op lenis.on('scroll') en roept lenis.scrollTo aan
 * (nagekeken in de dist), dus die opzet werkt.
 */
const OP_DESKTOP = window.matchMedia('(hover: hover) and (pointer: fine)');
// PROEF (20-8): Lenis ook op touch. Robin meldde op mobiel drie dingen -- de
// header niet zichtbaar bij laden, snappen dat soms te ver gaat, en horizontaal
// kunnen scrollen. De eerste twee komen van de NATIVE snap: die vangt al bij het
// laden, en zijn uitloop vliegt bij een flick over een grens heen. Lenis zet de
// native snap uit en doet het zelf, dus die twee kunnen ermee verdwijnen.
//
// De prijs is echt: syncTouch betekent dat Lenis het VINGERSCROLLEN overneemt
// van iOS -- momentum, rubber-band en het wegschuiven van de adresbalk worden
// dan een benadering in JavaScript. De makers waarschuwen daar zelf voor op
// iOS < 16. Dit staat er dus als proef, niet als besluit: voelt het niet goed,
// dan is OP_TOUCH weer false zetten de hele terugweg.
const OP_TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)');
const VENDOR_V = 1;   // ophogen als de bestanden in /assets/js/vendor wijzigen

let lenis = null;
let snap = null;

async function startLenis() {
  if (lenis || !(OP_DESKTOP.matches || OP_TOUCH.matches)) return;
  const [L, S] = await Promise.all([
    import(`/assets/vendor/lenis.mjs?v=${VENDOR_V}`),
    import(`/assets/vendor/lenis-snap.mjs?v=${VENDOR_V}`),
  ]);
  lenis = new L.default({
    // Lenis tekent de scrollbeweging zelf, maar STEVIG GEDEMPT (lerp 0.2 in
    // plaats van de standaard 0.1). Reden: een muiswiel scrollt in schokken en
    // heeft die demping nodig; een Mac-trackpad heeft zijn EIGEN momentum en
    // krijgt er dan een tweede overheen -- dat is precies het drijverige gevoel
    // waar Robin voor waarschuwde. Hoger betekent korter naijlen, dus dit is de
    // middenweg: de schokjes weg, de nasleep kort.
    // Staat het toch te zweven, dan is lerp omhoog (richting 1) of terug naar
    // smoothWheel:false de knop -- die stand werkte ook, met alleen de snap.
    smoothWheel: true,
    lerp: 0.2,
    // Alleen op touch overneemt hij het vingerscrollen; op desktop hoeft dat niet.
    syncTouch: OP_TOUCH.matches,
    // TOUCH-SPECIFIEK, want de standaardwaarden voelen op een telefoon traag.
    //
    // Waar dat zit is precies aan te wijzen. In Lenis staat
    // `lerp: d ? syncTouchLerp : 1`, waarbij d "de vinger is net losgelaten"
    // betekent. Tijdens het SLEPEN is de lerp dus 1 -- de inhoud volgt je vinger
    // exact, net als iOS, en daar is niets mis mee. De traagheid zit in de glijder
    // NA het loslaten: die gebruikt syncTouchLerp, en dat staat standaard op
    // 0.075. Dat dempt zo langzaam uit dat de pagina nog seconden naijlt.
    //
    // TWEE KNOPPEN, en ze doen iets anders -- dat verwarde ik eerst:
    //
    //   touchInertiaMultiplier   hoe VER een veeg je brengt
    //   syncTouchLerp            hoe snel de glijder UITDEMPT
    //
    // Eerste ronde zette ik de multiplier op 25 (korter dan de standaard 35),
    // omdat ik "te traag" las als "hij ijlt te lang na". Robin bedoelde het
    // omgekeerde: een veeg moet je VERDER brengen, zoals op iOS -- daar draagt
    // een flick een heel eind. Dus juist omhoog, ruim boven de standaard.
    //
    // De lerp gaat mee terug naar 0.1: tussen de trage standaard (0.075, dat
    // seconden naijlt) en de kordate 0.15 in. Met een langere weg af te leggen
    // mag de demping wat zachter, anders komt hij te abrupt tot stilstand.
    // Waar we na een paar rondes proberen op uitkwamen, met de betekenis erbij
    // omdat de tweede knop contra-intuitief is:
    //
    //   touchInertiaMultiplier 70   hoe VER een veeg draagt (standaard 35).
    //                               25 en 45 waren allebei te kort.
    //   syncTouchLerp 0.05          hoe snel hij zijn doel BENADERT. Hoger = eerder
    //                               aankomen en dus abrupt stoppen; LAGER = langer
    //                               onderweg blijven. Robin: "te stroef bij het
    //                               loslaten, mag echt een tijdje doorscrollen".
    //                               Dus omlaag, niet omhoog -- 0.15 en 0.1 kapten
    //                               de uitloop af.
    // syncTouchLerp 0.25: VIER KEER de vorige waarde, en ruim boven de standaard
    // van 0.075. Ik heb hem vier rondes lang de verkeerde kant op gedraaid omdat
    // ik "stroef" las als "hij stopt te vroeg" -- maar het betekende STROPERIG.
    // Een lage lerp benadert het doel langzaam en geeft dus een kruipende
    // uitloop; hoog betekent er vlot naartoe. Met de multiplier op 70 blijft de
    // AFSTAND groot, dus je gaat ver EN snel: dat is hoe een flick op iOS voelt.
    //
    // Kort samengevat, want dit is twee keer misgegaan:
    //   syncTouchLerp hoger  = sneller weg, korter narollen
    //   multiplier hoger     = verder komen
    ...(OP_TOUCH.matches ? { syncTouchLerp: 0.25, touchInertiaMultiplier: 70 } : {}),
    autoRaf: true,
  });
  snap = new S.default(lenis, {
    type: 'proximity',
    distanceThreshold: '12%',   // de vangzone, hier WEL instelbaar
    // Hoe lang na de laatste scrollbeweging hij mag vangen. De standaard is 500
    // en dat voelt als te laat. Op touch nog korter dan op desktop, want daar
    // eindigt een veeg in een lange, trage staart -- en juist dan wil je dat de
    // snap er snel bij is in plaats van te wachten tot de laatste pixel stil ligt.
    //
    // LET OP DE SPANNING: een vloeiendere uitloop (lagere syncTouchLerp) maakt
    // die staart langer, en stelt de snap dus uit. Deze twee getallen houden
    // elkaar in evenwicht; draai je aan de een, kijk dan ook naar de ander.
    // OP TOUCH JUIST LANG, en dat is het omgekeerde van wat ik vorige ronde deed.
    // Tussen je vinger loslaten en het op gang komen van de uitloop zit een korte
    // stilte in de scrollbeweging. Met 25ms viel de snap precies in dat gat: hij
    // greep op het moment van loslaten en knipte de veeg af -- wat aanvoelt als
    // "stroef bij het loslaten", en het werd er dan ook erger van. 200ms laat de
    // uitloop eerst zijn werk doen.
    debounce: OP_TOUCH.matches ? 200 : 60,
    // Op touch korter: een telefoon vraagt om directer antwoord dan een muis, en
    // de snap komt daar aan het eind van een lange uitloop -- dan mag hij kort.
    duration: OP_TOUCH.matches ? 0.18 : 0.4,
    // Vlot weg, dan steeds langzamer aankomen (Robin, 20-8). easeOutQuart: op de
    // helft van de tijd is 94% van de weg af, en de rest dempt zacht uit.
    // Bewust NIET Lenis' standaard easeOutExpo -- die schiet weg en kruipt dan
    // zo lang na dat het lijkt of hij niet afmaakt.
    easing: (t) => 1 - Math.pow(1 - t, 4),
  });
  // Het snappunt is de bovenkant van elk bericht. Het laatste doet niet mee:
  // zijn bovenkant is niet te bereiken, er zit te weinig pagina onder.
  const berichten = [...document.querySelectorAll('.feed-reader .read-post')];
  berichten.slice(0, -1).forEach((a) => snap.addElement(a, { align: 'start' }));
  // Native snappen uit: twee mechanismen op dezelfde scroller vechten.
  document.documentElement.style.scrollSnapType = 'none';
}

function stopLenis() {
  if (snap) { snap.destroy(); snap = null; }
  if (lenis) { lenis.destroy(); lenis = null; }
  document.documentElement.style.scrollSnapType = '';
}

/**
 * Omhoog niet snappen. Met Lenis is dat snap.stop()/start(); zonder Lenis (dus
 * op touch) zetten we de CSS-eigenschap om, precies zoals hiervoor.
 */
function zetSnappen(aan) {
  if (snap) { if (aan) snap.start(); else snap.stop(); return; }
  const el = document.documentElement;
  const wil = aan ? '' : 'none';
  if (el.style.scrollSnapType !== wil) el.style.scrollSnapType = wil;
}

/** Een richting geldt alleen als er NIETS beweegt. Anders negeren we hem. */
function nieuwGebaar(naarBeneden) {
  if (bezig) return;
  bezig = true;
  zetSnappen(naarBeneden);
}

/**
 * Het gebaar is pas voorbij als de SCROLL stil is, niet als de vinger loslaat:
 * op iOS loopt de uitloop daarna nog door. `scrollend` zegt dat precies, maar
 * bestaat niet overal (Chrome 114+, Safari 17+) -- vandaar ook de timer.
 */
function rustNu() { bezig = false; }
function planRust() {
  clearTimeout(rustTimer);
  rustTimer = setTimeout(rustNu, RUST_MS);
}

function opWiel(e) { if (Math.abs(e.deltaY) > 1) nieuwGebaar(e.deltaY > 0); }
let raakY = 0;
function opRaakStart(e) { if (e.touches && e.touches[0]) raakY = e.touches[0].clientY; }
function opRaakBeweeg(e) {
  if (!e.touches || !e.touches[0]) return;
  const y = e.touches[0].clientY;
  // Vinger omhoog = inhoud omlaag. Drie pixels speling tegen de trilling van een
  // duim die stilstaat.
  if (Math.abs(y - raakY) > 3) { nieuwGebaar(y < raakY); raakY = y; }
}
function opToets(e) {
  if (['ArrowDown', 'PageDown', 'End', ' ', 'Spacebar'].indexOf(e.key) >= 0) nieuwGebaar(true);
  else if (['ArrowUp', 'PageUp', 'Home'].indexOf(e.key) >= 0) nieuwGebaar(false);
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

  // De knop staat in de HTML, zodat hij er ook is zonder deze module -- dan doet
  // hij niets, maar hij springt niet in beeld bij het laden.
  knop = document.getElementById('read-top');
  if (knop) {
    knop.onclick = naarBoven;
    toonKnop(knop);
  }

  if (opScroll) {
    window.removeEventListener('scroll', opScroll);
    window.removeEventListener('scrollend', rustNu);
    window.removeEventListener('resize', opScroll);
    window.removeEventListener('wheel', opWiel);
    window.removeEventListener('touchstart', opRaakStart);
    window.removeEventListener('touchmove', opRaakBeweeg);
    window.removeEventListener('keydown', opToets);
  }
  // Elke scroll -- van een vinger of van de browser zelf -- houdt het gebaar
  // levend; pas als het stil blijft mag een nieuwe richting gelden.
  opScroll = () => { if (knop) toonKnop(knop); planRust(); };
  window.addEventListener('scroll', opScroll, { passive: true });
  window.addEventListener('scrollend', rustNu);
  window.addEventListener('resize', opScroll, { passive: true });
  window.addEventListener('wheel', opWiel, { passive: true });
  window.addEventListener('touchstart', opRaakStart, { passive: true });
  window.addEventListener('touchmove', opRaakBeweeg, { passive: true });
  window.addEventListener('keydown', opToets);

  // Alleen in de leesweergave, en alleen op desktop. Bij elke init() opnieuw
  // beoordelen: van Grid naar Lezen schakelen hoort hem aan te zetten, en
  // wegnavigeren hoort hem op te ruimen.
  stopLenis();
  if (document.body.dataset.feedView === 'reader') startLenis();
}

export default { init };
