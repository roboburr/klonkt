/**
 * Het bandje: een cassette die draait, en alleen vooruit en achteruit speelt.
 *
 * WAT DEZE MODULE WEL EN NIET DOET. Hij speelt niets af. De site heeft al een
 * speler (audio-player.js) met een wachtrij, een mini-speler onderin en een
 * sessie die een paginawissel overleeft. Een tweede speler ernaast bouwen om
 * een bandgevoel na te doen zou twee dingen tegelijk laten klinken en die hele
 * sessie weggooien. Dus: de afspeelknop draagt dezelfde data-attributen als een
 * albumhoes en wordt door die speler opgepakt, en spoelen is next()/prev().
 *
 * DAAROM SPOELT HET PER NUMMER en niet per seconde. Die speler denkt in een
 * wachtrij. Dat is een eerlijke benadering van een cassette: je komt vooruit en
 * achteruit, en je springt niet naar nummer zeven.
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

function opKlik(e) {
  const tape = e.target.closest && e.target.closest('.post-tape');
  if (!tape) return;
  const p = speler();

  const spoel = e.target.closest('[data-tape-go]');
  if (spoel) {
    if (!p) return;
    // Spoelen kan alleen als DIT bandje loopt. Anders zou de knop de wachtrij
    // van een ander blok verzetten, en dat is niet wat een spoelknop op deze
    // cassette hoort te doen.
    if (huidigeIndex(tape) < 0) return;
    if (spoel.dataset.tapeGo === 'fwd') p.next(); else p.prev();
    setTimeout(tekenAlles, 60);
    return;
  }

  const play = e.target.closest('[data-tape-play]');
  if (play && p) {
    // Loopt dit bandje al, dan is deze knop een pauzeknop. De globale
    // afhandelaar van audio-player.js zou hem anders opnieuw vanaf nummer een
    // starten, want die kent alleen "speel deze wachtrij".
    const i = huidigeIndex(tape);
    if (i >= 0) {
      e.preventDefault();
      e.stopPropagation();
      if (p.isPlaying()) p.pause(); else p.play();
      setTimeout(tekenAlles, 60);
    }
    // Staat het bandje stil, dan laten we de klik doorlopen: de speler pakt de
    // data-attributen op en zet de wachtrij op.
  }
}

export function init() {
  const tapes = document.querySelectorAll('.post-tape');

  // Altijd eerst opruimen, ook als er niets staat. Zonder dat blijft de tikker
  // lopen na een paginawissel naar een pagina zonder bandje -- dezelfde fout
  // die in de leesweergave een keer de hele site heeft vastgezet.
  if (tikker) { clearInterval(tikker); tikker = null; }
  if (gebonden) { gebonden.removeEventListener('click', opKlik, true); gebonden = null; }
  if (!tapes.length) return;

  // Vangen in de CAPTURE-fase, want de speler luistert zelf op document in de
  // bubbelfase. Alleen zo kan de pauzeknop zijn klik tegenhouden voordat de
  // wachtrij opnieuw wordt gezet.
  gebonden = document;
  gebonden.addEventListener('click', opKlik, true);

  tikker = setInterval(tekenAlles, TIK_MS);
  tekenAlles();
}
