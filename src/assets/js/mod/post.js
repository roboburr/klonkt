// De post-pagina: het "beantwoorden vanaf je eigen server"-veld (shaer-bqr).
//
// Stond inline in pages/post.ejs. Kwam je op een post via een link BINNEN de
// site, dan arriveerde dat script via htmx met een nonce die het document niet
// kent en weigerde de CSP het (shaer-0i6) -- dus deed de knop niets, precies op
// de plek waar de meeste bezoekers binnenkomen.
//
// Kon ongewijzigd mee: alles is al gedelegeerd op document, er wordt geen enkel
// pagina-element vastgehouden, en er staat een slot op. Dat is niet toevallig --
// het is geschreven voor een popover die na een htmx-swap moet blijven werken.

  (function(){
    if (window.__fediRemoteWired) return; window.__fediRemoteWired = true;
    var current = null, currentBtn = null;
    function close(){ if (current) { current.remove(); current = null; currentBtn = null; } }
    function go(raw, uri){
      var d = (raw||'').trim().replace(/^@?[^@\s]*@/, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
      if (d) { try { localStorage.setItem('pcmsFediServer', d); } catch(e){} location.href = 'https://' + d + '/authorize_interaction?uri=' + encodeURIComponent(uri||''); }
    }
    function place(f, b){
      var r = b.getBoundingClientRect();
      f.style.top = (r.bottom + window.scrollY + 6) + 'px';
      f.style.left = Math.max(8, Math.min(r.left + window.scrollX, window.scrollX + window.innerWidth - 340)) + 'px';
    }
    document.addEventListener('click', function(e){
      if (e.target.closest && e.target.closest('.fedi-remote-cancel')) { close(); return; }
      if (current && e.target.closest && e.target.closest('.fedi-remote-form')) return; // click inside → keep
      var b = e.target.closest && e.target.closest('.fedi-remote-reply-btn');
      if (b) {
        e.preventDefault();
        if (currentBtn === b) { close(); return; }   // toggle off
        close();
        var f = document.createElement('form');
        f.className = 'fedi-remote-form';
        f.dataset.uri = b.getAttribute('data-fedi-uri') || '';
        f.innerHTML = '<input type="text" autocomplete="off" spellcheck="false">'
          + '<button type="submit" class="btn btn-primary fedi-remote-go" aria-label="ok">&rarr;</button>'
          + '<button type="button" class="fedi-remote-cancel" aria-label="x">&times;</button>';
        var _inp = f.querySelector('input');
        _inp.placeholder = b.getAttribute('data-fedi-ph') || 'mastodon.social';
        try { var _sv = localStorage.getItem('pcmsFediServer'); if (_sv) _inp.value = _sv; } catch(e){}
        document.body.appendChild(f);            // floating popover → no layout reflow
        place(f, b); current = f; currentBtn = b;
        _inp.focus(); _inp.select();
        return;
      }
      if (current) close(); // click anywhere else closes it
    });
    document.addEventListener('submit', function(e){
      var f = e.target.closest && e.target.closest('.fedi-remote-form');
      if (!f) return; e.preventDefault();
      go(f.querySelector('input').value, f.dataset.uri);
    });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
    window.addEventListener('scroll', close, true);
  })();
  
