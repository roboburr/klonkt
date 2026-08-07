// Interactie autoriseren (pages/authorize-interaction.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

    (function () {
      if (window.__fediBmWired) return; window.__fediBmWired = true;
      var a = document.getElementById('fedi-bm-btn'); if (!a) return;
      a.setAttribute('href', "javascript:void(window.open('" + location.origin + "/authorize_interaction?uri='+encodeURIComponent(window.location.href)))");
      a.addEventListener('click', function (e) { e.preventDefault(); a.classList.add('nudge'); setTimeout(function(){ a.classList.remove('nudge'); }, 600); });
    })();
    

// ── volgend blok ──

      (function () {
        if (window.__fediEditWired) return; window.__fediEditWired = true;
        document.addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('.fedi-edit-btn');
          if (!b) return;
          var li = b.closest('.fedi-manage-item'); if (!li) return;
          var form = li.querySelector('.fedi-edit-form'); if (!form) return;
          var open = form.classList.toggle('is-open');
          b.classList.toggle('is-open', open);
          b.setAttribute('aria-expanded', open ? 'true' : 'false');
          if (open) { var ed = form.querySelector('.re-editor') || form.querySelector('textarea'); if (ed) ed.focus(); }
        });
      })();
      

// ── volgend blok ──

/* Like/Boost toggle in place — POST via fetch, flip the button, stay on the page. */
(function(){
  if (window.__fediReactWired) return; window.__fediReactWired = true;
  document.addEventListener('submit', function(e){
    var f = e.target.closest && e.target.closest('.fedi-react-form');
    if (!f) return;
    e.preventDefault();
    var btn = f.querySelector('button'); if (!btn || btn.disabled) return;
    btn.disabled = true;
    var body = new URLSearchParams();
    new FormData(f).forEach(function(v, k){ body.append(k, v); });
    fetch(f.action, { method: 'POST', body: body, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        if (j) {
          var on = !!j.on;
          btn.classList.toggle('is-on', on);
          var lbl = btn.querySelector('.fedi-bigact-label');
          if (lbl) lbl.textContent = on ? (btn.getAttribute('data-on') || lbl.textContent) : (btn.getAttribute('data-off') || lbl.textContent);
        }
      })
      .catch(function(){})
      .then(function(){ btn.disabled = false; });
  });
})();
