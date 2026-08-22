/**
 * Het bandje: een cassette die draait, en alleen vooruit en achteruit speelt.
 *
 * WAT DEZE MODULE WEL EN NIET DOET. Hij speelt niets af. De site heeft al een
 * speler (audio-player.js) met een wachtrij, een mini-speler onderin en een
 * sessie die een paginawissel overleeft. Een tweede speler ernaast bouwen om
 * een bandgevoel na te doen zou twee dingen tegelijk laten klinken en die hele
 * sessie weggooien. Dus: de afspeelknop draagt dezelfde data-attributen als een
 * albumhoes en wordt door die speler opgepakt.
 *
 * SPOELEN GAAT IN SECONDEN, over de nummergrenzen heen. Dat kan omdat die
 * speler een wachtrij in EEN doorlopende MediaSource-tijdlijn giet: "een
 * trackwissel is een positie, geen omschakeling". Een bandje is dus letterlijk
 * die tijdlijn. Vandaar seekBy() en niet next()/prev() -- springen per nummer
 * is een playlistgebaar, en dan is dit een lijst met een cassetteplaatje.
 *
 * WAAROM ER GEPOLLD WORDT. audio-player.js zendt geen gebeurtenissen uit -- het
 * is een gesloten module met een klein oppervlak (setQueue, play, pause, next,
 * prev, isPlaying, currentTrack). Liever hier vijf keer per seconde kijken dan
 * daar een gebeurtenissenlaag inbouwen die de rest van de site niet vraagt. Het
 * polsen stopt zodra er geen bandje op de pagina staat.
 */

const TIK_MS = 200;
let tikker = null;
let gebonden = null;   // de container waarop de klikafhandelaar hangt

/** De speler, of niets als hij (nog) niet geladen is. */
const speler = () => window.pcmsAudioPlayer || null;

/** De url's die op dit bandje staan, in volgorde. */
function bandUrls(tape) {
  try {
    return JSON.parse(tape.dataset.pcmsAlbum || '[]').map((t) => t.url);
  } catch { return []; }
}

/**
 * Speelt DIT bandje op dit moment? Vergelijken op url en niet op index: de
 * wachtrij kan ondertussen van een ander blok komen, en dan hoort deze cassette
 * gewoon stil te staan.
 */
function huidigeIndex(tape) {
  const p = speler();
  if (!p) return -1;
  const nu = p.currentTrack();
  if (!nu || !nu.url) return -1;
  return bandUrls(tape).indexOf(nu.url);
}

function tekenBand(tape) {
  const i = huidigeIndex(tape);
  const p = speler();
  const draait = i >= 0 && !!p && p.isPlaying();

  tape.classList.toggle('is-playing', draait);
  tape.classList.toggle('is-loaded', i >= 0);

  const knop = tape.querySelector('[data-tape-play]');
  if (knop) {
    knop.classList.toggle('is-pauze', draait);
    knop.setAttribute('aria-label', draait ? 'Pauzeren' : 'Afspelen');
  }

  // Welk nummer loopt er. Bij een bandje is dat de enige plek waar je het leest,
  // want de lijst is met opzet geen knoppenrij.
  const items = [...tape.querySelectorAll('.tape-track')];
  items.forEach((li, n) => li.classList.toggle('is-current', n === i));
  const nu = tape.querySelector('[data-tape-now]');
  if (nu) {
    const titel = i >= 0 && items[i] ? items[i].querySelector('.tape-track-title').textContent : '';
    nu.textContent = i >= 0 ? `${i + 1}. ${titel}` : '';
  }
}

function tekenAlles() {
  for (const tape of document.querySelectorAll('.post-tape')) tekenBand(tape);
}

/**
 * SPOELEN IS VASTHOUDEN, en dat is het verschil met een afspeellijst.
 *
 * Eerst deed vooruit en achteruit hier next()/prev(): een nummer verder. Dat is
 * een playlistgebaar. Op een cassette bestaat "volgend nummer" niet -- je houdt
 * de knop ingedrukt, de band loopt door, en je laat los waar je bent. Robin
 * wees daarop (21-8) en hij heeft gelijk: met knoppen die per nummer springen
 * is het een lijst met een cassetteplaatje erboven.
 *
 * Het versnelt terwijl je hem vasthoudt, zoals een echt bandje op gang komt.
 * Een korte TIK spoelt een klein stukje -- dat is er voor toetsenbord en
 * schermlezer, want vasthouden is met een spatiebalk geen gebaar.
 */
const START_SNELHEID = 4;    // maal de normale snelheid bij het indrukken
const MAX_SNELHEID = 16;
const VERSNELLING = 1.35;    // per stap
const STAP_MS = 120;
const TIK_STAP_S = 5;        // een losse klik

let winder = null;

function stopWinden(tape) {
  if (winder) { clearInterval(winder.timer); winder = null; }
  if (tape) tape.classList.remove('is-winding', 'is-winding-back');
}

function startWinden(tape, richting) {
  const p = speler();
  if (!p || huidigeIndex(tape) < 0) return;
  stopWinden(tape);
  let snelheid = START_SNELHEID;
  let vorigePositie = null;
  let stil = 0;
  tape.classList.add('is-winding');
  if (richting < 0) tape.classList.add('is-winding-back');
  const timer = setInterval(() => {
    snelheid = Math.min(MAX_SNELHEID, snelheid * VERSNELLING);
    p.seekBy(richting * snelheid * (STAP_MS / 1000));
    tekenBand(tape);
    // AAN HET EIND VAN DE BAND STOPPEN MET SPOELEN. De speler klemt de positie
    // af, dus daar gebeurt niets meer -- maar de spoelen bleven wel doordraaien
    // en de knop bleef oplichten, alsof er nog band was. Beweegt de teller twee
    // rondes niet, dan zijn we bij de kop of de staart.
    const nu = p.tapeTijden ? p.tapeTijden().cur : null;
    if (nu !== null && vorigePositie !== null && Math.abs(nu - vorigePositie) < 0.05) {
      if (++stil >= 2) { stopWinden(tape); return; }
    } else stil = 0;
    vorigePositie = nu;
  }, STAP_MS);
  winder = { timer, tape };
}

function opPointerDown(e) {
  const knop = e.target.closest && e.target.closest('[data-tape-go]');
  if (!knop) return;
  const tape = knop.closest('.post-tape');
  if (!tape) return;
  startWinden(tape, knop.dataset.tapeGo === 'fwd' ? 1 : -1);
}

function opPointerUp() {
  if (winder) stopWinden(winder.tape);
}

function opKlik(e) {
  const tape = e.target.closest && e.target.closest('.post-tape');
  if (!tape) return;
  const p = speler();

  const spoel = e.target.closest('[data-tape-go]');
  if (spoel) {
    // Een tik spoelt een stukje. Vasthouden gaat via de pointer-afhandelaars
    // hierboven; die hebben dan al gespoeld en deze klik doet er nog een klein
    // beetje bovenop, wat niet stoort.
    if (!p || huidigeIndex(tape) < 0) return;
    p.seekBy(spoel.dataset.tapeGo === 'fwd' ? TIK_STAP_S : -TIK_STAP_S);
    setTimeout(() => tekenBand(tape), 60);
    return;
  }

  const play = e.target.closest('[data-tape-play]');
  if (play && p) {
    // Loopt dit bandje al, dan is deze knop een pauzeknop. De globale
    // afhandelaar van audio-player.js zou hem anders opnieuw vanaf het begin
    // starten, want die kent alleen "speel deze wachtrij".
    const i = huidigeIndex(tape);
    if (i >= 0) {
      e.preventDefault();
      e.stopPropagation();
      if (p.isPlaying()) p.pause(); else p.play();
      setTimeout(tekenAlles, 60);
    }
    // Staat het bandje stil, dan laten we de klik doorlopen: de speler pakt de
    // data-attributen op en zet de band op.
  }
}

export function init() {
  const tapes = document.querySelectorAll('.post-tape');

  // Altijd eerst opruimen, ook als er niets staat. Zonder dat blijft de tikker
  // lopen na een paginawissel naar een pagina zonder bandje -- dezelfde fout
  // die in de leesweergave een keer de hele site heeft vastgezet.
  if (tikker) { clearInterval(tikker); tikker = null; }
  stopWinden(null);
  if (gebonden) {
    gebonden.removeEventListener('click', opKlik, true);
    gebonden.removeEventListener('pointerdown', opPointerDown, true);
    gebonden.removeEventListener('pointerup', opPointerUp, true);
    gebonden.removeEventListener('pointercancel', opPointerUp, true);
    gebonden = null;
  }
  if (!tapes.length) return;

  // Vangen in de CAPTURE-fase, want de speler luistert zelf op document in de
  // bubbelfase. Alleen zo kan de pauzeknop zijn klik tegenhouden voordat de
  // wachtrij opnieuw wordt gezet.
  gebonden = document;
  gebonden.addEventListener('click', opKlik, true);
  gebonden.addEventListener('pointerdown', opPointerDown, true);
  // Loslaten telt ook als je BUITEN de knop loslaat, anders blijft de band
  // doorspoelen als je met je vinger wegglijdt.
  gebonden.addEventListener('pointerup', opPointerUp, true);
  gebonden.addEventListener('pointercancel', opPointerUp, true);

  tikker = setInterval(tekenAlles, TIK_MS);
  tekenAlles();
}
