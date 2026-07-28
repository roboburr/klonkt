/* Guardian PWA client (FEP-633c): renders the dashboard, adopts wards, and
   manages the guardian push channel. No framework, no inline scripts (CSP).
   All user-facing text comes from state.strings (server i18n). */
(function () {
  'use strict';
  // A crash here used to fail silently (buttons just do nothing). Surface it on
  // the page AND the console so the cause is visible instead of "everything hangs".
  function fatal(msg) {
    try {
      var b = document.getElementById('g-fatal') || document.createElement('div');
      b.id = 'g-fatal'; b.className = 'g-msg err';
      b.style.cssText = 'display:block;margin:12px 0;padding:10px 14px';
      b.textContent = 'Guardian: ' + msg;
      var root = document.querySelector('main') || document.body;
      if (!b.parentNode && root) root.insertBefore(b, root.firstChild);
    } catch (e) { /* last resort */ }
    try { console.error('[guardian]', msg); } catch (e) { /* no console */ }
  }
  try {
  var S = JSON.parse(document.getElementById('guardian-state').textContent || '{}');
  var T = S.strings || {};

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function handleOf(uri, cached) {
    if (cached && cached.charAt(0) === '@') return cached;   // trust only real @handles
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
      var who = el('span', 'who grow');
      // name_html carries the custom emojis (FEP-9098) of the display name, the
      // same way de Krant renders a byline. Falls back to the plain name.
      if (h.name_html) who.innerHTML = h.name_html;
      else who.textContent = h.actor_name || handleOf(h.actor_uri, h.actor_handle);
      row.appendChild(who);
      row.appendChild(el('span', 'when', when(h.published || h.created_at)));
      card.appendChild(row);
      var body = el('div', 'body g-note');
      // body_html is the shared note-body partial, rendered server-side: the
      // content with its emojis, the quote / link-preview card and the media.
      // Falls back to the bare content for rows stored before that existed.
      body.innerHTML = h.body_html || h.content || '';   // sanitized server-side on ingest
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
      var wave = el('button', 'small', T.wave || '👋 Wave');
      wave.addEventListener('click', function () { sendWave(w.other_uri, wave); });
      row.appendChild(wave);
      // Gated feature: external (non-fediverse) embeds. Off by default for a
      // ward; only a guardian can open it, and the gate is enforced server-side
      // when the feed is built, so this button is the only thing that moves it.
      // Shown for EVERY ward, including one on another server. There the value
      // is unknown (it lives on the ward's server), but proposing is exactly as
      // possible: the proposal travels, the ward's server tallies the guardians
      // and enforces. A guardian next door must not have more say than one far
      // away.
      var known = w.embeds === true || w.embeds === false;
      var emb = el('button', 'quiet small',
        (known ? (w.embeds ? T.embeds_on : T.embeds_off) : T.embeds_propose) || 'Link previews');
      emb.addEventListener('click', function () {
        emb.disabled = true;
        fetch('/guardian/wards/embeds', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: w.other_uri, allow: known ? !w.embeds : true }),
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            // Not settled yet: the other guardians still have to answer.
            if (j && j.state === 'open') {
              emb.textContent = (T.embeds_waiting || 'waiting for the other guardians');
              emb.disabled = true;
              return;
            }
            refresh();
          })
          .catch(function () { emb.disabled = false; });
      });
      row.appendChild(emb);
      var btn = el('button', 'quiet small', T.release);
      // Releasing a ward is heavy and hard to undo (coming back needs a fresh
      // offer the ward accepts), so it asks first and spells out what changes.
      btn.addEventListener('click', function () {
        var who = handleOf(w.other_uri, w.other_handle);
        var msg = (T.release_confirm || 'Release {who}?').replace('{who}', who);
        if (window.confirm(msg)) remove(w.other_uri, btn);
      });
      row.appendChild(btn);
      card.appendChild(row);
      list.appendChild(card);
    });
    show('wards-empty', wards.length === 0);
  }

  function sendWave(uri, btn) {
    btn.disabled = true;
    fetch('/guardian/api/wave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ward: uri, site: S.site }),
    }).then(function (r) { return r.json(); })
      .then(function (j) { btn.disabled = false; btn.textContent = (j && j.ok) ? (T.waved || '👋 sent') : (T.wave || '👋 Wave'); })
      .catch(function () { btn.disabled = false; });
  }

  function remove(uri, btn) {
    btn.disabled = true;
    fetch('/guardian/wards/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: uri, site: S.site }),
    }).then(refresh);
  }

  function renderAll() { renderHelp(); renderPending(); renderWards(); }

  // ── 0. Wards' corner: read-only feed of your wards' posts ───────────────
  function renderFeed(items) {
    var list = document.getElementById('feed-list');
    list.textContent = '';
    (items || []).forEach(function (p) {
      var card = el('div', 'g-card feed');
      var head = el('div', 'row');
      head.appendChild(el('span', 'who grow', p.author));
      if (p.published) head.appendChild(el('span', 'g-when', when(p.published)));
      card.appendChild(head);
      var body = el('div', 'feed-body');
      if (p.cw) {
        var d = document.createElement('details');
        var sum = document.createElement('summary'); sum.textContent = p.cw; d.appendChild(sum);
        var inner = el('div'); inner.innerHTML = p.content || ''; d.appendChild(inner);
        body.appendChild(d);
      } else {
        body.innerHTML = p.content || '';   // server-sanitized HTML (same as Berichten)
      }
      card.appendChild(body);
      list.appendChild(card);
    });
    show('feed-section', (items || []).length > 0);
  }

  function loadFeed() {
    return fetch('/guardian/api/feed?site=' + encodeURIComponent(S.site))
      .then(function (r) { return r.json(); })
      .then(function (f) { if (f && !f.error) renderFeed(f.items); })
      .catch(function () { /* corner just stays hidden */ });
  }

  // ── 0b. Follow requests on your wards (§5.3) ────────────────────────────
  function answerFollow(id, decision, btn) {
    if (btn) btn.disabled = true;
    fetch('/guardian/api/follow/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: decision, site: S.site }),
    }).then(loadFollowReqs);
  }
  function renderFollowReqs(items) {
    var list = document.getElementById('follow-list');
    list.textContent = '';
    (items || []).forEach(function (f) {
      var card = el('div', 'g-card');
      var row = el('div', 'row');
      row.appendChild(el('span', 'who grow', f.follower + '  →  ' + f.ward));
      var ok = el('button', 'small', T.accept || 'Accept');
      ok.addEventListener('click', function () { answerFollow(f.id, 'approve', ok); });
      var no = el('button', 'quiet small', T.reject || 'Deny');
      no.addEventListener('click', function () { answerFollow(f.id, 'reject', no); });
      row.appendChild(ok); row.appendChild(no);
      card.appendChild(row);
      list.appendChild(card);
    });
    show('follow-section', (items || []).length > 0);
  }
  function loadFollowReqs() {
    return fetch('/guardian/api/follow-requests?site=' + encodeURIComponent(S.site))
      .then(function (r) { return r.json(); })
      .then(function (f) { if (f && !f.error) renderFollowReqs(f.items); })
      .catch(function () { /* stays hidden */ });
  }

  function refresh() {
    return fetch('/guardian/api/state?site=' + encodeURIComponent(S.site))
      .then(function (r) { return r.json(); })
      .then(function (s) { if (s && !s.error) { S = s; T = s.strings || T; renderAll(); } })
      .then(loadFeed).then(loadFollowReqs);
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

  renderAll(); pushState(); loadFeed(); loadFollowReqs();
  setInterval(refresh, 45000);   // live-ish while open
  } catch (e) {
    fatal((e && e.message) || String(e));
  }
})();
