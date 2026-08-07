// De Krant -- verplaatst uit inline script, shaer-bqr.
//
// Inline script wordt door de CSP geweigerd zodra deze pagina via een link
// BINNEN de site binnenkomt (shaer-0i6). Wat de server meegeeft komt uit
// pageData(); interpolatie kan niet in een statisch bestand.

import { pageData } from './lib.js';

// De twee gedelegeerde blokken dragen een window-vlag en zijn bij een tweede
// init een no-op; de twee SCANNERS (gif-video's, lees-meer) moeten juist wel
// elke render opnieuw over de verse elementen lopen (shaer-5s1). Element-
// vlaggen (data-gif-wired, data-rm) houden dubbel bedraden tegen.
export function init() { run(); }

function run() {

  (function () {
    if (window.__tlPasteWired) return; window.__tlPasteWired = true;
    function modal() { return document.getElementById('tl-paste'); }
    function openM() {
      var m = modal(); if (!m) return;
      var inp = m.querySelector('.tl-paste-input');
      m.classList.add('is-open');
      if (inp) {
        inp.value = ''; inp.focus();
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function (t) {
            t = (t || '').trim();
            if (/^https?:\/\//i.test(t) && !inp.value) { inp.value = t; inp.select(); }
          }).catch(function () {});
        }
      }
    }
    function closeM() { var m = modal(); if (m) m.classList.remove('is-open'); }
    function go() {
      var m = modal(); if (!m) return;
      var inp = m.querySelector('.tl-paste-input'), v = (inp ? inp.value : '').trim();
      if (!/^https?:\/\//i.test(v)) { if (inp) inp.focus(); return; }
      location.href = '/authorize_interaction?uri=' + encodeURIComponent(v);
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#tl-paste-btn')) { e.preventDefault(); openM(); return; }
      if (e.target.closest && e.target.closest('.tl-paste-go')) { e.preventDefault(); go(); return; }
      if (e.target.closest && (e.target.closest('.tl-paste-cancel') || e.target.closest('.tl-paste-x'))) { e.preventDefault(); closeM(); return; }
      var op = document.querySelector('.tl-paste.is-open'); if (op && e.target === op) closeM();
    });
    document.addEventListener('keydown', function (e) {
      var m = document.querySelector('.tl-paste.is-open'); if (!m) return;
      if (e.key === 'Escape') closeM();
      else if (e.key === 'Enter' && e.target.closest && e.target.closest('.tl-paste')) { e.preventDefault(); go(); }
    });
  })();
  

// ── volgend blok ──

(function(){
  if (window.__fediRemoteWired) return; window.__fediRemoteWired = true;
  var current = null, currentBtn = null;
  function close(){ if (current) { current.remove(); current = null; currentBtn = null; } }
  function go(raw, uri){ var d=(raw||'').trim().replace(/^@?[^@\s]*@/,'').replace(/^https?:\/\//i,'').replace(/\/.*$/,'').trim(); if(d){ try{ localStorage.setItem('pcmsFediServer', d); }catch(e){} location.href='https://'+d+'/authorize_interaction?uri='+encodeURIComponent(uri||''); } }
  function place(f, b){ var r=b.getBoundingClientRect(); f.style.top=(r.bottom+window.scrollY+6)+'px'; f.style.left=Math.max(8, Math.min(r.left+window.scrollX, window.scrollX+window.innerWidth-340))+'px'; }
  document.addEventListener('click', function(e){
    if (e.target.closest && e.target.closest('.fedi-remote-cancel')) { close(); return; }
    if (current && e.target.closest && e.target.closest('.fedi-remote-form')) return;
    var b = e.target.closest && e.target.closest('.fedi-remote-reply-btn');
    if (b) {
      e.preventDefault();
      if (currentBtn === b) { close(); return; }
      close();
      var f = document.createElement('form'); f.className='fedi-remote-form'; f.dataset.uri = b.getAttribute('data-fedi-uri')||'';
      f.innerHTML = '<input type="text" autocomplete="off" spellcheck="false"><button type="submit" class="btn btn-primary fedi-remote-go" aria-label="ok">&rarr;</button><button type="button" class="fedi-remote-cancel" aria-label="x">&times;</button>';
      var _inp = f.querySelector('input'); _inp.placeholder = b.getAttribute('data-fedi-ph') || 'mastodon.social';
      try{ var _sv = localStorage.getItem('pcmsFediServer'); if(_sv) _inp.value = _sv; }catch(e){}
      document.body.appendChild(f); place(f, b); current=f; currentBtn=b; _inp.focus(); _inp.select();
      return;
    }
    if (current) close();
  });
  document.addEventListener('submit', function(e){ var f=e.target.closest && e.target.closest('.fedi-remote-form'); if(!f) return; e.preventDefault(); go(f.querySelector('input').value, f.dataset.uri); });
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
  window.addEventListener('scroll', close, true);
})();

/* Short feed videos (gif/cover loops like an animated cover) autoplay + loop muted like a GIF;
   longer real videos keep their controls. Decided on the actual duration once metadata loads. */
wireGifVideos();

/* Like/Boost toggle in place — POST via fetch, flip the button, stay on the page (no reload, no banner). */
(function(){
  if (window.__newsReactWired) return; window.__newsReactWired = true;
  document.addEventListener('submit', function(e){
    var f = e.target.closest && e.target.closest('.tl-react-form');
    if (!f) return;
    e.preventDefault();
    var btn = f.querySelector('button'); if (!btn || btn.disabled) return;
    btn.disabled = true;
    var body = new URLSearchParams();
    new FormData(f).forEach(function(v, k){ body.append(k, v); });
    fetch(f.action, { method: 'POST', body: body, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){ if (j) btn.classList.toggle('is-on', !!j.on); })
      .catch(function(){})
      .then(function(){ btn.disabled = false; });
  });
})();

// ── volgend blok ──

// Collapse long post bodies to a max height with a "read more" toggle — only when the content
// actually overflows. Runs on every /news render (full load + htmx swap); a per-element flag
// prevents double-wiring.
wireReadMore();
}

/* Short feed videos: zie de opmerking bij de aanroep in run(). */
function wireGifVideos(){
  document.querySelectorAll('.tl-media-video').forEach(function(v){
    if (v.dataset.gifWired) return; v.dataset.gifWired = '1';
    var decide = function(){
      if (v.duration && v.duration <= 30) {
        v.removeAttribute('controls'); v.loop = true; v.muted = true; v.play().catch(function(){});
      }
    };
    if (v.readyState >= 1) decide(); else v.addEventListener('loadedmetadata', decide, { once: true });
  });
}

function wireReadMore(){
  var _d = pageData(); var RM = _d.readMore || 'Lees meer', SL = _d.showLess || 'Toon minder';
  document.querySelectorAll('.tl-content:not(.nsfw-media):not([data-rm])').forEach(function(c){
    c.setAttribute('data-rm', '1');
    if (c.scrollHeight > 360) {
      c.classList.add('tl-clamp');
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'tl-readmore'; b.textContent = RM;
      b.addEventListener('click', function(){
        b.textContent = c.classList.toggle('tl-clamp') ? RM : SL;
      });
      c.insertAdjacentElement('afterend', b);
    }
  });
}

// Paginering: items die de feed later binnenhaalt zouden de scanners missen --
// init() draait per NAVIGATIE, en een pagineer-swap is er geen. Een keer,
// gedelegeerd; op andere pagina's vinden de scanners niets en doen ze niets.
document.body.addEventListener('htmx:afterSettle', function () { wireGifVideos(); wireReadMore(); });
