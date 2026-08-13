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

  // MusicBrainz-paneel (shaer-mbz). Binnen run(), niet op moduleniveau: deze
  // modules krijgen bij elke paginawissel opnieuw init(), en een blok dat maar
  // een keer per sessie draait is precies wat shaer-5s1 opleverde.
  wireMusicBrainz();
}

// ── MusicBrainz: ben jij dit? (shaer-mbz) ─────────────────────────
//
// De kandidaten komen van de server, want MusicBrainz eist een verzoek per
// seconde per APPLICATIE en een User-Agent met contact -- allebei niet vanuit
// een browser af te dwingen.
//
// WIJ KIEZEN NIET. Ook niet als er precies een treffer is: een verkeerd geraden
// MBID zet jouw naam onder andermans werk. De knop staat er, de klik is van de
// artiest. En de keuze gaat mee met de Opslaan-knop van de pagina -- een eigen
// formulier kan hier niet, want deze pagina IS er een.
function wireMusicBrainz() {
  const knop = document.getElementById('mb-zoek-btn');
  const veld = document.getElementById('mb-q');
  const uit = document.getElementById('mb-uit');
  const idVeld = document.getElementById('mb-id');
  const naamVeld = document.getElementById('mb-naam');
  const huidig = document.getElementById('mb-huidig');
  if (!knop || !veld || !uit || !idVeld || knop.__wired) return;
  knop.__wired = true;

  const el = (tag, cls, tekst) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    // textContent en nooit innerHTML: dit is tekst uit een vreemd register.
    if (tekst != null) e.textContent = tekst;
    return e;
  };

  function zet(mbid, naam) {
    idVeld.value = mbid || '';
    naamVeld.value = naam || '';
    if (huidig) {
      huidig.hidden = !mbid;
      const n = document.getElementById('mb-huidig-naam');
      const a = document.getElementById('mb-huidig-link');
      if (n) n.textContent = naam || mbid || '';
      if (a) a.href = mbid ? `https://musicbrainz.org/artist/${mbid}` : '#';
    }
    uit.hidden = true;
    uit.replaceChildren();
  }

  const wis = document.getElementById('mb-wis');
  if (wis) wis.addEventListener('click', () => zet('', ''));

  async function zoek() {
    const q = (veld.value || '').trim();
    if (!q) return;
    uit.hidden = false;
    uit.replaceChildren(el('p', 'form-hint', T.asite_mb_busy || 'Zoeken…'));
    knop.disabled = true;
    try {
      const r = await fetch(`api/musicbrainz?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const j = await r.json();
      toon((j && j.kandidaten) || []);
    } catch {
      uit.replaceChildren(el('p', 'form-hint', T.asite_mb_fail || 'MusicBrainz is even niet bereikbaar.'));
    } finally {
      knop.disabled = false;
    }
  }

  function toon(kandidaten) {
    if (!kandidaten.length) {
      uit.replaceChildren(el('p', 'form-hint', T.asite_mb_none || 'Niets gevonden.'));
      return;
    }
    const lijst = el('ul', 'mb-lijst');
    for (const k of kandidaten) {
      const li = el('li', 'mb-kandidaat');
      li.appendChild(el('strong', null, k.naam));
      // De toelichting is het hele punt: er zijn drie bands die Nirvana heten,
      // en zonder dit veld kiest iemand de verkeerde.
      const bij = [k.toelichting, k.soort, k.land, k.jaren].filter(Boolean).join(' · ');
      if (bij) li.appendChild(el('small', 'mb-bij', bij));
      const open = el('a', 'mb-open', T.asite_mb_open || 'Bekijk op MusicBrainz');
      open.href = k.url; open.target = '_blank'; open.rel = 'noopener';
      li.appendChild(open);
      const b = el('button', 'btn', T.asite_mb_pick || 'Dit ben ik');
      b.type = 'button';
      b.addEventListener('click', () => zet(k.mbid, k.naam));
      li.appendChild(b);
      lijst.appendChild(li);
    }
    uit.replaceChildren(lijst);
  }

  knop.addEventListener('click', zoek);
  veld.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); zoek(); } });
}
