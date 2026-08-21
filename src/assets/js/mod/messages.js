// Berichten: filteren, zoeken, en gesprekken in- en uitklappen (shaer-bqr).
//
// Dit stond inline in pages/messages.ejs. Dat werkte alleen na een volledige
// laadbeurt: kwam je hier via een link BINNEN de site, dan arriveerde het script
// via htmx met een nonce die het document niet kent, en weigerde de CSP het
// (shaer-0i6). Chips, zoeken en het inklappen deden dan niets, en de reply-editor
// laadde niet -- dat was Barts melding.
//
// TWEE DINGEN VERANDERD bij de verhuizing, en ze zijn allebei nodig omdat een
// module ANDERS leeft dan een inline script:
//
//   NIETS VASTHOUDEN   het inline script pakte .msg-list, #msg-q en .msg-nomatch
//                      een keer bij het inladen. Een module wordt per document
//                      maar EEN keer geimporteerd, dus als je Berichten verlaat
//                      en terugkomt wijzen die naar elementen die er niet meer
//                      zijn. Nu wordt er per keer opgezocht.
//   OPNIEUW INDEXEREN  bij binnenkomst op deze pagina, niet alleen bij "meer
//                      laden". Anders is de lijst na een navigatie niet
//                      geindexeerd en filtert het zoeken op niets.
//
// Alles gedelegeerd op document, met een slot: de module kan een tweede keer
// geladen worden en mag dan geen tweede stel luisteraars neerzetten.

(function () {
  'use strict';
  if (window.__msgWired) return;
  window.__msgWired = true;

  var kind = 'all';
  var items = [];

  // Per keer opzoeken. Zie de kop: vasthouden overleeft een navigatie niet.
  function list() { return document.querySelector('.msg-list'); }
  function noMatch() { return document.querySelector('.msg-nomatch'); }
  function query() { return document.getElementById('msg-q'); }

  function indexItem(li) {
    // Een draad indexeren op zijn eerste bubbel zou de rest onvindbaar maken,
    // dus daar nemen we de hele tekst; losse regels blijven gericht geindexeerd.
    if (li.classList.contains('msg-thread')) {
      li._search = ((li.getAttribute('data-who') || '') + ' ' + li.textContent).toLowerCase();
      return;
    }
    var body = li.querySelector('.msg-content');
    var post = li.querySelector('.msg-post');
    var poll = li.querySelector('.msg-poll');
    li._search = ((li.getAttribute('data-who') || '') + ' ' +
      (body ? body.textContent : '') + ' ' + (post ? post.textContent : '') + ' ' +
      (poll ? poll.textContent : '')).toLowerCase();
  }

  function reindex() {
    var l = list();
    items = l ? Array.prototype.slice.call(l.querySelectorAll(':scope > .msg-item')) : [];
    items.forEach(function (li) { if (!li._search) indexItem(li); });
  }

  function apply() {
    if (!list()) return;
    var qEl = query();
    var term = (qEl && qEl.value || '').trim().toLowerCase();
    var shown = 0;
    items.forEach(function (li) {
      var ok = (kind === 'all' || li.getAttribute('data-kind') === kind) &&
        (!term || li._search.indexOf(term) !== -1);
      li.style.display = ok ? '' : 'none';
      // Een treffer die in een dichtgeklapt gesprek zit, laat anders alleen de
      // naam zien: je zoekt iets, het staat er, en je ziet het niet. Zolang er
      // gezocht wordt gaat zo'n gesprek open; daarna keert hij terug naar de
      // stand die de lezer zelf koos.
      if (li.classList.contains('msg-thread')) {
        li.classList.toggle('is-search-open', !!term && ok);
      }
      if (ok) shown++;
    });
    var nm = noMatch();
    if (nm) nm.hidden = shown !== 0;
  }

  // In- en uitklappen door op de tegenpartij te tikken. De stand leeft alleen in
  // deze pagina: standaard uitgeklapt, en na een herlading weer. Dat is bewust --
  // een gesprek dat je gisteren dichtklapte stilhouden is niet hetzelfde als het
  // opruimen van je scherm van nu.
  document.addEventListener('click', function (e) {
    var who = e.target.closest && e.target.closest('.msg-thread-who'); if (!who) return;
    var li = who.closest('.msg-thread'); if (!li) return;
    var collapsed = li.classList.toggle('is-collapsed');
    who.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  });

  document.addEventListener('click', function (e) {
    var chip = e.target.closest && e.target.closest('.msg-chip'); if (!chip) return;
    kind = chip.getAttribute('data-show');
    document.querySelectorAll('.msg-chip').forEach(function (c) { c.classList.toggle('is-on', c === chip); });
    apply();
  });

  // Gedelegeerd in plaats van op het invoerveld zelf: dat veld wordt bij een
  // navigatie vervangen.
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'msg-q') apply();
  });

  document.body.addEventListener('htmx:afterSettle', function (e) {
    // "Meer laden" voegt rijen toe aan de bestaande lijst; een navigatie brengt
    // een hele nieuwe lijst. In beide gevallen opnieuw indexeren en de actieve
    // chip toepassen.
    if (e.target && (e.target.id === 'msg-list' || e.target.querySelector && e.target.querySelector('.msg-list'))) {
      reindex();
      apply();
    }
  });

  // De bookmarklet-knop: bouwt zijn href pas in de browser, want hij heeft de
  // origin nodig.
  function wireBookmarklet() {
    var a = document.getElementById('fedi-bm-btn');
    if (!a || a.__wired) return;
    a.__wired = true;
    a.setAttribute('href', "javascript:void(window.open('" + location.origin + "/authorize_interaction?uri='+encodeURIComponent(window.location.href)))");
    a.addEventListener('click', function (e) {
      e.preventDefault();
      a.classList.add('nudge');
      setTimeout(function () { a.classList.remove('nudge'); }, 600);
    });
  }

  // Zwaaien ter plekke: een seintje is geen paginawissel.
  //
  // Het formulier blijft een echt formulier -- zonder JS post het en leidt de
  // route om, precies als vroeger. Hier onderscheppen we het en sturen het met
  // fetch, zoals like/boost in de Krant het al deden.
  //
  // LET OP DE VERZENDKNOP. Deze formulieren hebben er MEERDERE ("Wat leuk!",
  // "Hoe gaat het?", "Terug"), elk met een eigen name="text". FormData(f) neemt
  // de aangeklikte knop NIET mee -- dat doet de browser alleen bij een echte
  // verzending. Zonder submitter vertrekt er dus een zwaai zonder tekst, en die
  // weigert de route. Vandaar submitter, met een terugval op de eerste knop.
  document.addEventListener('submit', function (e) {
    var f = e.target.closest && e.target.closest('.msg-wave, .msg-quickreply');
    if (!f || f.dataset.sending) return;
    e.preventDefault();
    var knoppen = [].slice.call(f.querySelectorAll('button'));
    var knop = e.submitter || knoppen[0];
    if (!knop) return;
    f.dataset.sending = '1';
    knoppen.forEach(function (b) { b.disabled = true; });
    var body = new URLSearchParams();
    new FormData(f).forEach(function (v, k) { body.append(k, v); });
    if (knop.name) body.set(knop.name, knop.value);
    fetch(f.action, {
      method: 'POST', body: body,
      headers: { 'X-Requested-With': 'fetch' },
      credentials: 'same-origin',
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok) throw new Error('geweigerd');
        // Gelukt: de knoppen maken plaats voor de bevestiging. Zwaaien is
        // eenmalig -- anders dan een like valt het niet terug te draaien, dus
        // een aan/uit-knop zou liegen over wat er kan.
        var klaar = document.createElement('span');
        klaar.className = 'msg-wave-done';
        klaar.textContent = '👋 ' + (f.dataset.sent || '');
        f.replaceChildren(klaar);
      })
      .catch(function () {
        // Mislukt: alles terug zoals het was, zodat een tweede poging kan.
        delete f.dataset.sending;
        knoppen.forEach(function (b) { b.disabled = false; });
        f.classList.add('is-failed');
        setTimeout(function () { f.classList.remove('is-failed'); }, 600);
      });
  });

  function start() { reindex(); apply(); wireBookmarklet(); }
  start();
  // Kom je hier via een link binnen de site, dan is de lijst er pas na de swap.
  document.body.addEventListener('pcmsNav', start);
})();
