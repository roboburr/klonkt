// Site bewerken in beheer (pages/admin-site-edit.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

// Element-bedrading leeft zo lang als de pagina; de bootstrap roept init()
// aan bij elke paginawissel waarop deze module actief is (shaer-5s1).
export function init() { run(); }

function run() {
    (function(){
      if (window.__themePreviewWired) return; window.__themePreviewWired = true;
      var html = document.documentElement;
      function applyAccent(hex){
        if(!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
        var sa = document.getElementById('pcms-site-accent');
        if(!sa){ sa = document.createElement('style'); sa.id = 'pcms-site-accent'; document.head.appendChild(sa); }
        sa.textContent = ':root,[data-palette]{--accent:'+hex+';--accent-soft:color-mix(in srgb,'+hex+' 80%,white);--accent-tint:color-mix(in srgb,'+hex+' 12%,transparent);}';
      }
      document.addEventListener('change', function(e){
        var t = e.target; if(!t || !t.name) return;
        if(t.name === 'palette'){ html.setAttribute('data-palette', t.value); }
        else if(t.name === 'accent'){ applyAccent(t.value); }
        else if(t.name === 'theme_override'){
          if(t.value === 'light' || t.value === 'dark'){ html.setAttribute('data-theme', t.value); }
          else { var dk = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; html.setAttribute('data-theme', dk ? 'dark' : 'light'); }
        }
      });
    })();
    

// ── volgend blok ──

(function() {
  // Slug URL field: show the real host as a dimmed prefix (the slug itself is
  // coloured via CSS). Hub → host/user/<slug>, otherwise host/<slug>.
  var sh = document.getElementById('slug-host');
  if (sh) sh.textContent = location.host + (sh.dataset.prefix || '/');
})();
(function() {
  // Profile-links repeater: add row from <template>, remove on click.
  var rows = document.getElementById('profile-links-rows');
  var tpl  = document.getElementById('profile-link-template');
  var add  = document.getElementById('profile-link-add');
  if (!rows || !tpl || !add) return;

  add.addEventListener('click', function() {
    var clone = tpl.content.cloneNode(true);
    rows.appendChild(clone);
  });
  rows.addEventListener('click', function(e) {
    if (e.target && e.target.classList.contains('pl-remove')) {
      var row = e.target.closest('.profile-link-row');
      if (row) row.remove();
    }
  });
})();

// P63 — Profile photo picker: upload via /admin/sites/upload-photo,
// then write the returned URL into the visible input. Live thumb preview.
(function() {
  var picker  = document.getElementById('photo-picker');
  if (!picker) return;
  var thumb   = document.getElementById('photo-thumb');
  var preview = document.getElementById('photo-preview');
  var urlEl   = document.getElementById('photo-url');
  var trigger = document.getElementById('photo-upload-trigger');
  var clear   = document.getElementById('photo-clear');
  var field   = document.getElementById('photo-upload-field');
  var status  = document.getElementById('photo-status');

  function showPreview(url) {
    if (url) {
      preview.src = url;
      preview.hidden = false;
      thumb.removeAttribute('data-empty');
      clear.hidden = false;
    } else {
      preview.src = '';
      preview.hidden = true;
      thumb.setAttribute('data-empty', '');
      clear.hidden = true;
    }
  }

  if (urlEl) {
    urlEl.addEventListener('input', function() {
      showPreview(urlEl.value.trim());
    });
  }

  if (trigger && field) {
    trigger.addEventListener('click', function() { field.click(); });
    field.addEventListener('change', async function() {
      var file = field.files && field.files[0];
      if (!file) return;
      status.classList.remove('is-error');
      status.textContent = 'Uploaden…';
      try {
        var fd = new FormData();
        fd.append('photo', file);
        var r = await fetch('/admin/sites/upload-photo', {
          method: 'POST',
          body: fd,
          credentials: 'same-origin',
        });
        var j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || ('Upload mislukt (' + r.status + ')'));
        urlEl.value = j.url;
        showPreview(j.url);
        status.textContent = 'Geüpload ✓';
        setTimeout(function() { status.textContent = ''; }, 2000);
      } catch (e) {
        status.classList.add('is-error');
        status.textContent = 'Mislukt: ' + e.message;
      } finally {
        field.value = '';
      }
    });
  }

  if (clear) {
    clear.addEventListener('click', function() {
      urlEl.value = '';
      showPreview('');
      status.textContent = '';
      // Note: doesn't delete the file from disk — saving the form with empty
      // URL leaves the file orphaned on the server. Acceptable for now.
    });
  }
})();
}
