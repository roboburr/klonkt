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
}

export default { init };
