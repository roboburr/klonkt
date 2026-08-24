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

// ── Paginamodus ─────────────────────────────────────────────────────────────
/**
 * Elk bericht een paneel dat zelf scrollt; tussen berichten ga je met knoppen.
 *
 * Robins voorstel (20-8) nadat het namaken van iOS-momentum niet lukte, en dat
 * is de winst: in dit model DOET het scrollgevoel er niet toe. Er is geen
 * momentum om na te bouwen en geen snap die vangt.
 *
 * Hoe het werkt:
 *  - lenis.stop() zet het scrollen van de STROOM stil. Lenis vangt dan wiel en
 *    vinger af (hij preventDefault't in onVirtualScroll), dus je kunt niet meer
 *    tussen berichten door scrollen.
 *  - data-lenis-prevent op elk paneel houdt de scroll BINNEN een bericht
 *    ongemoeid. Dat werkt ook terwijl Lenis gestopt is, want die controle staat
 *    in zijn bron vóór de gestopt-controle. Nagekeken in de dist, niet gehoopt.
 *  - Bewegen tussen panelen gaat met lenis.scrollTo(..., { force: true }), want
 *    force is precies de uitzondering die een gestopte Lenis toch laat scrollen.
 *
 * Geldt waar een bericht een eigen scherm heeft: op mobiel altijd, op desktop
 * als de site dat instelt (reader_full_page). Buiten die modus verandert er
 * niets -- dan is Lenis gewoon aan en scrol je vrij.
 */
/**
 * PAGINAMODUS STAAT UIT -- maar de code blijft staan (Robin, 20-8: "weghalen
 * maar bewaren, voor als ik het later weer wil").
 *
 * Wat het is: elk bericht een paneel van een scherm dat zelf scrolt, met twee
 * balken om ertussen te navigeren en de stroomscroll vastgezet. Gebouwd omdat
 * het namaken van iOS-momentum niet lukte; in dit model doet het scrollgevoel er
 * namelijk niet toe. Mobiel is nu terug op systeemscroll met snap, en dat is wat
 * er ook stond voordat we dit probeerden.
 *
 * Aanzetten: deze constante op true. Dan komen de balken terug (CSS hangt aan
 * body.is-paged), stopt Lenis de stroomscroll en scrollen de panelen zelf.
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
  if (lenis) lenis.scrollTo(doel, { force: true });
  else doel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(zetBalken, 80);
}

/**
 * Omhoog vanaf het EERSTE bericht brengt je naar de header.
 *
 * In paginamodus staat Lenis stil, dus de pagina scrolt niet meer met je vinger
 * -- en dan is alles boven het eerste bericht onbereikbaar. Robin liep daar
 * tegenaan (20-8): "ik kan niet meer terug scrollen naar de header". De
 * omhoog-knop is daar de enige weg naartoe, dus die krijgt er een trede bij.
 */
function gaOmhoog() {
  const i = huidigIndex();
  if (i > 0) { gaNaar(i - 1); return; }
  if (lenis) lenis.scrollTo(0, { force: true });
  else window.scrollTo({ top: 0, behavior: 'smooth' });
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
  const aan = paginaModus();
  document.body.classList.toggle('is-paged', aan);
  panelen().forEach((a) => {
    if (aan) a.setAttribute('data-lenis-prevent', '');
    else a.removeAttribute('data-lenis-prevent');
  });
  if (lenis) { if (aan) lenis.stop(); else lenis.start(); }
  zetBalken();
}

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
let ooitGescrold = false;   // snappen begint UIT, zie zetSnappen()
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
  // DESKTOP EN TOUCH ALLEBEI. Er heeft hier een tijd gestaan dat mobiel terug was
  // op de systeemscroll; dat klopte niet meer met de regel hieronder, die
  // syncTouch juist AANzet op touch. Reden dat Lenis ook op de telefoon meedraait:
  // zijn snap heeft zijn scroll-gebeurtenissen nodig om te kunnen timen.
  if (lenis || !(OP_DESKTOP.matches || OP_TOUCH.matches)) return;
  const [L, S] = await Promise.all([
    import(`/assets/vendor/lenis.mjs?v=${VENDOR_V}`),
    import(`/assets/vendor/lenis-snap.mjs?v=${VENDOR_V}`),
  ]);
  lenis = new L.default({
    /**
     * Wat Lenis MET RUST LAAT.
     *
     * In paginamodus staat Lenis stil en scrolt alleen het paneel van het
     * bericht zelf. Dat regelde ik eerst met een data-lenis-prevent-attribuut
     * dat de module op elk paneel zette -- maar dan hangt het scrollen af van of
     * dat attribuut op tijd en op elk (ook later bijgeladen) paneel staat, en
     * Robin kon binnen een lang bericht niet scrollen.
     *
     * Deze functie stelt dezelfde vraag zonder die afhankelijkheid: is dit een
     * bericht-paneel? Dan bemoeit Lenis zich er niet mee en scrolt de browser
     * het zelf -- wat op een telefoon precies is wat je wilt, want dat is de
     * systeemscroll.
     */
    prevent: (node) => !!(node && node.classList
      && node.classList.contains('read-post')
      && document.body.classList.contains('is-paged')),
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
    // Twee touch-knoppen, en ze doen echt iets anders. Lenis rekent bij het
    // LOSLATEN eenmalig een doel uit -- afstand = snelheid^touchInertiaExponent
    // -- en kruipt daar dan naartoe met syncTouchLerp.
    //
    //   touchInertiaExponent  hoe VER de flick draagt   (standaard 1.7)
    //   syncTouchLerp         hoe hard hij REMT         (standaard 0.075)
    //
    // Let op: `touchInertiaMultiplier` bestaat NIET in 1.3.26. Lenis slikt
    // onbekende opties zonder fout, dus zo'n regel lijkt te werken en doet niets.
    // Controleer een optienaam in src/assets/vendor/lenis.mjs voor je hem zet.
    //
    // Robin wilde langer en sneller uitrollen zonder remgevoel, dus de exponent
    // gaat omhoog (een stevige flick draagt daarmee ruim vier tot zes keer zo
    // ver) en de lerp gaat juist boven de standaard: hij legt die afstand vlot
    // af in plaats van er stroperig naartoe te kruipen.
    ...(OP_TOUCH.matches ? { syncTouchLerp: 0.09, touchInertiaExponent: 2.2 } : {}),
    autoRaf: true,
  });
  snap = new S.default(lenis, {
    type: 'proximity',
    // DE VANGZONE, en dit is HET getal om aan te draaien. Ooit 12%, toen 55%
    // (20-8: eerder vangen, boven de reacties), en 20-8 terug naar 12% -- want
    // sinds het snappen alleen nog vooruit werkt, voelde die brede zone als
    // trekken tijdens het lezen. 12% is ~110 pixels op een venster van 910: hij
    // vangt pas vlak vóór de lijn.
    // Houd dit gelijk aan vangZone() hieronder: deze drempel bepaalt of
    // lenis/snap überhaupt aanklopt, die andere of wij het doorlaten. Zet je
    // deze lager dan die, dan komt onze regel nooit aan bod.
    distanceThreshold: '12%',
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
    // Met een iOS-achtige uitloop duurt de staart lang; te kort wachten laat de
    // snap midden in de vlucht ingrijpen. 150ms laat hem uitrollen en vangt dan.
    debounce: OP_TOUCH.matches ? 150 : 60,
    // Op touch korter: een telefoon vraagt om directer antwoord dan een muis, en
    // de snap komt daar aan het eind van een lange uitloop -- dan mag hij kort.
    duration: OP_TOUCH.matches ? 0.18 : 0.4,
    // Vlot weg, dan steeds langzamer aankomen (Robin, 20-8). easeOutQuart: op de
    // helft van de tijd is 94% van de weg af, en de rest dempt zacht uit.
    // Bewust NIET Lenis' standaard easeOutExpo -- die schiet weg en kruipt dan
    // zo lang na dat het lijkt of hij niet afmaakt.
    easing: (t) => 1 - Math.pow(1 - t, 4),
  });
  // Het snappunt is de bovenkant van elk bericht -- ook van het laatste. Dat
  // deed eerder niet mee omdat zijn bovenkant onbereikbaar was; sinds het
  // laatste bericht in CSS een volle schermhoogte krijgt, kan hij wel.
  const berichten = [...document.querySelectorAll('.feed-reader .read-post')];
  berichten.forEach((a) => snap.addElement(a, { align: 'start' }));

  // ALLEEN VOORUIT VANGEN. Dit hoort bij de ruime zone hierboven en is niet
  // optioneel: lenis/snap kiest het DICHTSTBIJZIJNDE punt en zijn drempel geldt
  // naar twee kanten. Scroll je een lang bericht in en stop je 300 pixels onder
  // de bovenkant, dan is die bovenkant het dichtstbij -- en met een zone van 400
  // wordt je teruggetrokken. Dat is precies de klacht "ik kan niet scrollen
  // binnen een lang bericht", en met de oude zone van 86 pixels viel het alleen
  // niet op.
  //
  // Dus: een doel ACHTER je slaan we over. Ligt er een punt voor je binnen de
  // zone, dan gaan we daarheen; anders gebeurt er niets en scrol je vrij door.
  // Zo verruimt de zone alleen de kant waar hij bedoeld is.
  //
  // Waarom niet gewoon de drempel? Omdat lenis/snap alleen de dichtstbijzijnde
  // kandidaat beoordeelt: zonder deze omleiding houdt de zone vooruit op bij de
  // helft van de afstand tussen twee berichten, hoe groot je de drempel ook zet.
  //
  // DE REGEL, in Robins woorden (20-8): "enkel bij downscrollen, aan de
  // onderkant van elke post, snappen naar de lijn tussen de posts" -- en geen
  // snap op een bericht dat al voorbij is gescrold. Drie voorwaarden dus:
  //   1. de laatste echte beweging ging omlaag,
  //   2. het doel ligt VOOR je (een punt achter je slaan we over),
  //   3. het ligt binnen de vangzone -- die begint rond de voet van het bericht.
  // Het doel zelf blijft de bovenkant van het volgende bericht: dat IS de lijn
  // ertussen, en dat is het essentiële.
  //
  // DE ZONE IS EEN GETAL, geen '55%'. Die string kwam ongewijzigd uit de opties
  // en werd hier met een getal vergeleken -- altijd onwaar, dus deze terugval
  // heeft nooit gewerkt en alleen het doel dat lenis zelf koos kwam erdoor.
  const vangZone = () => 0.12 * window.innerHeight;   // gelijk aan distanceThreshold hierboven
  // Lenis' eigen `direction` is het teken van de snelheid, en die is bij het
  // afvuren van de (gedebouncede) snap alweer nul. Daarom onthouden we de
  // laatste richting die er echt was.
  let laatsteRichtingOmlaag = true;
  lenis.on('scroll', () => {
    if (Math.abs(lenis.velocity) > 0.05) laatsteRichtingOmlaag = lenis.velocity > 0;
  });
  const echtGaNaar = snap.goTo.bind(snap);
  snap.goTo = (index) => {
    if (!laatsteRichtingOmlaag) return;   // omhoog: nooit vangen
    const punten = snap.computeSnaps();   // zelfde volgorde als goTo intern gebruikt
    const nu = lenis.scroll;
    let vooruit = -1;
    punten.forEach((punt, i) => {
      if (punt.value > nu + 2 && (vooruit < 0 || punt.value < punten[vooruit].value)) vooruit = i;
    });
    if (vooruit < 0) return;              // niets meer voor je: vrij uitscrollen
    if (punten[vooruit].value - nu <= vangZone()) echtGaNaar(vooruit);
  };

  // OP TOUCH DOET DE MODULE-EIGEN TRIGGER HET NIET, en dat is meetbaar in de
  // vendor-bron, geen vermoeden. Drie feiten op een rij:
  //
  //   1. lenis geeft 'virtual-scroll' door met de RUWE vingerdelta, VOOR hij
  //      de uitloop uitrekent (teken * |snelheid|^touchInertiaExponent).
  //   2. lenis-snap negeert elke touchmove en beoordeelt dus EEN keer per
  //      gebaar, op touchend, met `scroll + rawDelta` -- de plek waar je
  //      vinger LOSLIET.
  //   3. de uitloop draagt daarna nog honderden pixels verder.
  //
  // De snapbeslissing valt dus op een positie die de scroll meteen verlaat.
  // Op desktop klopt dezelfde som wel: wieldelta's zijn klein en de
  // smoothWheel-uitloop is kort, dus voorspelling en landing liggen bijeen.
  // Vandaar: op touch de module-trigger eraf en zelf beoordelen tegen
  // lenis.targetScroll -- die wordt synchroon bij touchend gezet en IS het
  // exacte landingspunt van de uitloop.
  if (OP_TOUCH.matches) {
    lenis.off('virtual-scroll', snap.onSnapDebounced);
    let raakTimer = null;
    let vertrek = 0;   // scrollpositie bij loslaten: punten daarachter zijn
                       // de bovenkant van het HUIDIGE bericht, nooit grijpen
    lenis.on('virtual-scroll', (e) => {
      const soort = e.event && e.event.type;
      if (soort === 'touchstart' || soort === 'touchmove') { clearTimeout(raakTimer); return; }
      if (soort !== 'touchend') return;
      vertrek = lenis.scroll;
      clearTimeout(raakTimer);
      raakTimer = setTimeout(() => {
        if (!laatsteRichtingOmlaag) return;
        const doel = lenis.targetScroll;   // de echte landing, niet de raakdelta
        const punten = snap.computeSnaps();
        let best = -1;
        punten.forEach((punt, i) => {
          if (punt.value <= vertrek + 2) return;
          if (Math.abs(doel - punt.value) > vangZone()) return;
          if (best < 0 || Math.abs(doel - punt.value) < Math.abs(doel - punten[best].value)) best = i;
        });
        // Landt de uitloop net VOORBIJ een bovenkant, dan is een klein stukje
        // terug naar die lijn precies de gevraagde snap -- geen terugtrekking,
        // want punten achter het loslaatpunt zijn hierboven al uitgesloten.
        if (best >= 0) echtGaNaar(best);
      }, 150);
    });
  }

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
  // Zonder Lenis (mobiel) zetten we de CSS-eigenschap om. Hij staat bij het
  // laden UIT -- dat is de standaardstand van deze variabele -- zodat de browser
  // niet meteen naar het eerste bericht springt en de header wegvalt. Pas je
  // eerste gebaar naar beneden zet hem aan.
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
  // EERST OPRUIMEN, en pas daarna terugvallen als er geen leesstroom is.
  //
  // Dit stond andersom, en dat brak het scrollen op de HELE site: navigeerde je
  // van Lezen naar het beheer, dan viel init() bij de ontbrekende leesstroom
  // meteen terug -- en bleef Lenis leven EN gestopt (lenis.stop() vangt wiel en
  // vinger af). Daarna scrolde niets meer, ook niet op pagina's die met Lezen
  // niets te maken hebben. Robins melding (20-8): "scrollen werkt nu nergens ook
  // niet in admin panels".
  //
  // Opruimen hoort dus bij het VERLATEN van de weergave, niet bij het opzetten
  // ervan. init() draait bij elke paginawissel, dus dit is de plek.
  stopLenis();
  document.body.classList.remove('is-paged');
  document.querySelectorAll('[data-lenis-prevent].read-post')
    .forEach((a) => a.removeAttribute('data-lenis-prevent'));

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
    window.removeEventListener('scrollend', rustNu);
    window.removeEventListener('resize', opScroll);
    window.removeEventListener('wheel', opWiel);
    window.removeEventListener('touchstart', opRaakStart);
    window.removeEventListener('touchmove', opRaakBeweeg);
    window.removeEventListener('keydown', opToets);
  }
  // Elke scroll -- van een vinger of van de browser zelf -- houdt het gebaar
  // levend; pas als het stil blijft mag een nieuwe richting gelden.
  opScroll = () => {
    if (knop) toonKnop(knop);
    planRust();
    if (document.body.classList.contains('is-paged')) zetBalken();
  };
  window.addEventListener('scroll', opScroll, { passive: true });
  window.addEventListener('scrollend', rustNu);
  window.addEventListener('resize', opScroll, { passive: true });
  window.addEventListener('wheel', opWiel, { passive: true });
  window.addEventListener('touchstart', opRaakStart, { passive: true });
  window.addEventListener('touchmove', opRaakBeweeg, { passive: true });
  window.addEventListener('keydown', opToets);

  const balkBoven = document.getElementById('read-prev');
  const balkOnder = document.getElementById('read-next-nav');
  if (balkBoven) balkBoven.onclick = gaOmhoog;
  if (balkOnder) balkOnder.onclick = () => gaNaar(huidigIndex() + 1);

  // Alleen in de leesweergave, en alleen op desktop. Bij elke init() opnieuw
  // beoordelen: van Grid naar Lezen schakelen hoort hem aan te zetten, en
  // wegnavigeren hoort hem op te ruimen.
  if (document.body.dataset.feedView === 'reader') startLenis().then(pasPaginaModusToe);
  else pasPaginaModusToe();


}

export default { init };
