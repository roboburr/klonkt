/* Guardian PWA client (FEP-633c): renders the dashboard, adopts wards, and
   manages the guardian push channel. No framework, no inline scripts (CSP).
   All user-facing text comes from state.strings (server i18n). */
(function () {
  'use strict';
  var S = JSON.parse(document.getElementById('guardian-state').textContent || '{}');
  var T = S.strings || {};

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
  function when(s) { return String(s || '').slice(0, 16).replace('T', ' '); }
  function show(id, on) { document.getElementById(id).hidden = !on; }

  // ── 1. Help requests ───────────────────────────────────────────────────
  function renderHelp() {
    var list = document.getElementById('help-list');
    list.textContent = '';
    var help = S.help || [];
    help.forEach(function (h) {
      var card = el('div', 'g-card help');
      var row = el('div', 'row');
      row.appendChild(el('span', 'who grow', h.actor_name || handleOf(h.actor_uri, h.actor_handle)));
      row.appendChild(el('span', 'when', when(h.published || h.created_at)));
      card.appendChild(row);
      var body = el('div', 'body');
      body.innerHTML = h.content || '';          // sanitized server-side on ingest
      card.appendChild(body);
      if (h.note_url) {
        var a = el('a', 'g-link', T.open || 'open');
        a.href = h.note_url; a.target = '_blank'; a.rel = 'noopener';
        card.appendChild(a);
      }
      list.appendChild(card);
    });
    var badge = document.getElementById('help-count');
    badge.textContent = help.length; badge.hidden = help.length === 0;
    show('help-empty', help.length === 0);
  }

  // ── 3. Offers I am a party to (sent, or a co-guardianship to co-approve) ─
  function answer(offerId, decision, btn) {
    if (btn) btn.disabled = true;
    fetch('/guardian/offer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offer: offerId, answer: decision, site: S.site }),
    }).then(refresh);
  }
  function offerCard(o) {
    var card = el('div', 'g-card');
    var row = el('div', 'row');
    var subject = o['shaer:iAmCandidate']
      ? handleOf(o['shaer:ward'], o['shaer:wardHandle'])            // my sent offer: about the ward
      : handleOf(o['shaer:candidate'], o['shaer:candidateHandle']); // co-guard: who wants in
    row.appendChild(el('span', 'who grow', subject));
    if (o['shaer:iAmCandidate']) {
      // My own offer, waiting for the others to accept.
      row.appendChild(el('span', 'tag wait', T.pending));
      var rt = el('button', 'quiet small', T.retract);
      rt.addEventListener('click', function () { answer(o.id, 'reject', rt); });
      row.appendChild(rt);
    } else if (o['shaer:needsMyAccept']) {
      // A co-guardianship offer for a ward I already guard: my call.
      row.appendChild(el('span', 'tag co', T.coguard));
      var ac = el('button', 'small', T.accept);
      ac.addEventListener('click', function () { answer(o.id, 'accept', ac); });
      var rj = el('button', 'quiet small', T.reject);
      rj.addEventListener('click', function () { answer(o.id, 'reject', rj); });
      row.appendChild(ac); row.appendChild(rj);
    } else {
      row.appendChild(el('span', 'tag wait', T.awaiting_others));
    }
    card.appendChild(row);
    return card;
  }
  function renderPending() {
    var list = document.getElementById('pending-list');
    list.textContent = '';
    var offers = S.offers || [];
    offers.forEach(function (o) { list.appendChild(offerCard(o)); });
    show('pending-section', offers.length > 0);
  }

  // ── 4. Accepted wards ──────────────────────────────────────────────────
  function renderWards() {
    var list = document.getElementById('wards-list');
    list.textContent = '';
    var wards = S.wards || [];
    wards.forEach(function (w) {
      var card = el('div', 'g-card');
      var row = el('div', 'row');
      row.appendChild(el('span', 'who grow', handleOf(w.other_uri, w.other_handle)));
      row.appendChild(el('span', 'tag ok', T.active));
      var btn = el('button', 'quiet small', T.release);
      btn.addEventListener('click', function () { remove(w.other_uri, btn); });
      row.appendChild(btn);
      card.appendChild(row);
      list.appendChild(card);
    });
    show('wards-empty', wards.length === 0);
  }

  function remove(uri, btn) {
    btn.disabled = true;
    fetch('/guardian/wards/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: uri, site: S.site }),
    }).then(refresh);
  }

  function renderAll() { renderHelp(); renderPending(); renderWards(); }

  function refresh() {
    return fetch('/guardian/api/state?site=' + encodeURIComponent(S.site))
      .then(function (r) { return r.json(); })
      .then(function (s) { if (s && !s.error) { S = s; T = s.strings || T; renderAll(); } });
  }

  // ── 2. Adopt ───────────────────────────────────────────────────────────
  var form = document.getElementById('adopt-form');
  var input = document.getElementById('adopt-handle');
  var adoptBtn = document.getElementById('adopt-btn');
  var msg = document.getElementById('adopt-msg');
  function setMsg(text, isErr) { msg.hidden = false; msg.className = 'g-msg' + (isErr ? ' err' : ''); msg.textContent = text; }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var handle = input.value.trim();
    if (!handle) return;
    adoptBtn.disabled = true;
    setMsg(T.sending || '…', false);
    fetch('/guardian/adopt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: handle, site: S.site }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        adoptBtn.disabled = false;
        if (res.ok) {
          input.value = '';
          // Always refresh: the offer is recorded even if delivery is still
          // in flight. Show it under "Verzonden aanvragen".
          setMsg(res.j.delivered === false ? T.sent_retry : T.sent, false);
          refresh();
        } else {
          setMsg((res.j.error === 'not_found' ? T.not_found : T.failed) , true);
        }
      })
      .catch(function () { adoptBtn.disabled = false; setMsg(T.network, true); });
  });

  // ── Site picker ────────────────────────────────────────────────────────
  var picker = document.getElementById('site-picker');
  if (picker) picker.addEventListener('change', function () {
    location.href = '/guardian?site=' + encodeURIComponent(picker.value);
  });

  // ── 5. Push ────────────────────────────────────────────────────────────
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
        toggle.classList.toggle('is-on', !!sub);
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
            alerts: { help: 1, guardian: 1, dm: 1, follow: 0, reply: 0, like: 0, boost: 0 },
            uaLabel: 'Guardian PWA',
          }),
        });
      }).then(pushState).catch(function (e) {
        pmsg.hidden = false; pmsg.className = 'g-msg err';
        pmsg.textContent = (T.push_unavailable || 'Push unavailable') + ': ' + e.message;
      });
    });
  });

  renderAll(); pushState();
  setInterval(refresh, 45000);   // live-ish while open
})();
