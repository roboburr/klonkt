/* Guardian PWA client (FEP-633c): renders the dashboard state, adopts wards,
   and manages the guardian push channel (web-push slice reused: alert types
   'help' + 'guardian'). No framework, no inline scripts (CSP). */
(function () {
  'use strict';
  var state = JSON.parse(document.getElementById('guardian-state').textContent || '{}');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function handleOf(uri, cached) {
    if (cached) return cached;
    try { var u = new URL(uri); return '@' + u.pathname.split('/').filter(Boolean).pop() + '@' + u.host; }
    catch (e) { return uri; }
  }
  function when(s) {
    return String(s || '').slice(0, 16).replace('T', ' ');
  }

  // ── Message centre: help requests ──────────────────────────────────────
  function renderHelp() {
    var list = document.getElementById('help-list');
    list.textContent = '';
    (state.help || []).forEach(function (h) {
      var card = el('div', 'g-card help');
      var row = el('div', 'row');
      var who = el('span', 'who', h.actor_name || handleOf(h.actor_uri, h.actor_handle));
      var at = el('span', 'when', when(h.published || h.created_at));
      row.appendChild(who); row.appendChild(at);
      card.appendChild(row);
      var body = el('div', 'body');
      body.innerHTML = h.content || '';           // sanitized server-side on ingest
      card.appendChild(body);
      if (h.note_url) {
        var link = el('a', 'when', 'open');
        link.href = h.note_url; link.target = '_blank'; link.rel = 'noopener';
        card.appendChild(link);
      }
      list.appendChild(card);
    });
    document.getElementById('help-empty').hidden = (state.help || []).length > 0;
  }

  // ── Wards + pending offers ─────────────────────────────────────────────
  function wardCard(w, pending) {
    var card = el('div', 'g-card');
    var row = el('div', 'row');
    var who = el('span', 'who grow', handleOf(w.other_uri, w.other_handle));
    row.appendChild(who);
    if (pending) row.appendChild(el('span', 'pend', state.strings.pending));
    var btn = el('button', 'quiet', pending ? state.strings.retract : state.strings.release);
    btn.addEventListener('click', function () {
      fetch('/guardian/wards/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: w.other_uri, site: state.site }),
      }).then(refresh);
    });
    row.appendChild(btn);
    card.appendChild(row);
    return card;
  }
  function renderWards() {
    var wl = document.getElementById('wards-list');
    var ol = document.getElementById('offers-list');
    wl.textContent = ''; ol.textContent = '';
    (state.wards || []).forEach(function (w) { wl.appendChild(wardCard(w, false)); });
    (state.pendingOffers || []).forEach(function (w) { ol.appendChild(wardCard(w, true)); });
    document.getElementById('wards-empty').hidden =
      (state.wards || []).length + (state.pendingOffers || []).length > 0;
  }

  function refresh() {
    fetch('/guardian/api/state?site=' + encodeURIComponent(state.site))
      .then(function (r) { return r.json(); })
      .then(function (s) { if (s && !s.error) { state = s; renderHelp(); renderWards(); } });
  }

  // ── Adopt ──────────────────────────────────────────────────────────────
  document.getElementById('adopt-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = document.getElementById('adopt-handle');
    var msg = document.getElementById('adopt-msg');
    var handle = input.value.trim();
    if (!handle) return;
    msg.hidden = false; msg.classList.remove('err'); msg.textContent = '…';
    fetch('/guardian/adopt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handle, site: state.site }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) { msg.textContent = state.strings.sent; input.value = ''; refresh(); }
        else { msg.classList.add('err'); msg.textContent = state.strings.failed + ': ' + (res.j.error || '?'); }
      })
      .catch(function () { msg.classList.add('err'); msg.textContent = state.strings.network; });
  });

  // ── Site picker ────────────────────────────────────────────────────────
  var picker = document.getElementById('site-picker');
  if (picker) picker.addEventListener('change', function () {
    location.href = '/guardian?site=' + encodeURIComponent(picker.value);
  });

  // ── Push: the guardian channel (help + guardian alerts) ────────────────
  var toggle = document.getElementById('push-toggle');
  var pmsg = document.getElementById('push-msg');
  function pushState() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toggle.disabled = true; return; }
    navigator.serviceWorker.register('/sw.js').catch(function () {});
    navigator.serviceWorker.ready
      .then(function (reg) { return reg.pushManager.getSubscription(); })
      .then(function (sub) {
        toggle.textContent = sub ? toggle.dataset.onLabel : toggle.dataset.offLabel;
        toggle.dataset.subscribed = sub ? '1' : '';
      });
  }
  function urlB64(base64) {
    var pad = '='.repeat((4 - (base64.length % 4)) % 4);
    var b = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b); var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  toggle.addEventListener('click', function () {
    pmsg.hidden = true;
    navigator.serviceWorker.ready.then(function (reg) {
      if (toggle.dataset.subscribed) {
        reg.pushManager.getSubscription().then(function (sub) {
          if (!sub) return;
          fetch('/push/unsubscribe', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          }).then(function () { return sub.unsubscribe(); }).then(pushState);
        });
        return;
      }
      fetch('/push/vapid').then(function (r) { return r.json(); }).then(function (v) {
        if (!v.publicKey) throw new Error('no key');
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(v.publicKey) });
      }).then(function (sub) {
        return fetch('/push/subscribe', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription: sub.toJSON(),
            // The guardian channel: calls for help + adoption traffic.
            alerts: { help: 1, guardian: 1, dm: 1, follow: 0, reply: 0, like: 0, boost: 0 },
            uaLabel: 'Guardian PWA',
          }),
        });
      }).then(pushState).catch(function (e) {
        pmsg.hidden = false; pmsg.classList.add('err');
        pmsg.textContent = 'Push niet beschikbaar: ' + e.message;
      });
    });
  });

  renderHelp(); renderWards(); pushState();
  // Live-ish: poll the state every 45s while the PWA is open.
  setInterval(refresh, 45000);
})();
