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
  // The server hands over a timestamp already formatted in the site's timezone
  // (Beheer -> Instellingen), the same clock de Krant and Berichten show. The
  // slice is only a fallback for a row that predates that field: it shows raw
  // UTC, which is what made a 20:20 call for help read 18:20.
  function when(item, raw) {
    if (item && item.when_text) return item.when_text;
    return String(raw || '').slice(0, 16).replace('T', ' ');
  }
  function show(id, on) { document.getElementById(id).hidden = !on; }

  // ── 1. Help requests ───────────────────────────────────────────────────
  // A call for help is not an alarm: it may well be settled quietly between a
  // guardian and the child. So the card carries no siren, it just has to be
  // impossible to miss. It shows up twice on purpose (Robins keuze): the recent
  // ones across all children at the top, the full history of one child in that
  // child's panel.
  var HELP_TOP = 5;

  function helpCard(h) {
    var card = el('div', 'g-card help');
    var row = el('div', 'row');
    var who = el('span', 'who grow');
    // name_html carries the custom emojis (FEP-9098) of the display name, the
    // same way de Krant renders a byline. Falls back to the plain name.
    if (h.name_html) who.innerHTML = h.name_html;
    else who.textContent = h.actor_name || handleOf(h.actor_uri, h.actor_handle);
    row.appendChild(who);
    row.appendChild(el('span', 'when', when(h, h.published || h.created_at)));
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
    return card;
  }

  function renderHelp() {
    var list = document.getElementById('help-list');
    list.textContent = '';
    var help = S.help || [];
    help.slice(0, HELP_TOP).forEach(function (h) { list.appendChild(helpCard(h)); });
    if (help.length > HELP_TOP) {
      list.appendChild(el('p', 'g-sec-sub', '+ ' + (help.length - HELP_TOP) + ' — ' + (T.panel_help || '')));
    }
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
  /** A running lapse (FEP-633c 3.6.3): the available co-guardians deciding
   *  to release a dormant one. Votes ride the same Accept/Reject wire as the
   *  offers; buttons appear only for set members (the ward watches, it does
   *  not vote). */
  function lapseCard(l) {
    var card = el('div', 'g-card lapse');
    card.appendChild(el('div', 'who', (T.lapse_line || '{who} has stopped answering as a guardian of {ward}.')
      .replace('{who}', handleOf(l.object.object)).replace('{ward}', handleOf(l.object['shaer:ward']))));
    card.appendChild(el('div', 'g-avlabel', (T.lapse_tally || '{n} of {need} agreed; closes {date}.')
      .replace('{n}', l['shaer:accepts']).replace('{need}', l['shaer:threshold'])
      .replace('{date}', new Date(l['shaer:closesAt']).toLocaleDateString())));
    var row = el('div', 'row');
    var inSet = (l['shaer:set'] || []).indexOf(S.me) >= 0;
    if (inSet && !l['shaer:myVote']) {
      var yes = el('button', 'small', T.lapse_agree || 'Agree');
      yes.addEventListener('click', function () { answer(l.id, 'accept', yes); });
      var no = el('button', 'quiet small', T.lapse_disagree || 'Disagree');
      no.addEventListener('click', function () { answer(l.id, 'reject', no); });
      row.appendChild(yes); row.appendChild(no);
    } else if (inSet) {
      row.appendChild(el('span', 'g-avlabel', T.voted || 'You voted'));
    }
    card.appendChild(row);
    card.appendChild(el('p', 'g-empty small', T.lapse_note || ''));
    return card;
  }

  /** A gated-setting proposal (FEP-633c 5.6) a fellow guardian opened on a
   *  ward we share, forwarded here by the ward's server. Answering is the
   *  whole point: without a second voice the threshold is never met and the
   *  proposal quietly expires. */
  function gatedCard(g) {
    var card = el('div', 'g-card gated');
    var line = g.value ? (T.gated_line_on || '') : (T.gated_line_off || '');
    card.appendChild(el('div', 'who', line
      .replace('{who}', handleOf(g.proposer || ''))
      .replace('{ward}', handleOf(g.ward))));
    var row = el('div', 'row');
    var yes = el('button', 'small', T.gated_agree || 'Agree');
    var no = el('button', 'quiet small', T.gated_disagree || 'Disagree');
    function answerGated(decision, btn) {
      btn.disabled = true;
      fetch('/guardian/api/gated/' + encodeURIComponent(g.id), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: decision, site: S.site }),
      }).then(refresh).catch(function () { btn.disabled = false; });
    }
    yes.addEventListener('click', function () { answerGated('accept', yes); });
    no.addEventListener('click', function () { answerGated('reject', no); });
    row.appendChild(yes); row.appendChild(no);
    card.appendChild(row);
    return card;
  }

  function renderPending() {
    var list = document.getElementById('pending-list');
    list.textContent = '';
    var offers = S.offers || [];
    var gated = S.gatedReviews || [];
    // The offers state carries the adoption offers; the lapse proposals ride
    // separately so a lapse never renders as an adoption.
    var lapses = (S.lapses || []).filter(function (l) { return l['shaer:outcome'] === 'open'; });
    offers.forEach(function (o) {
      if (o.object && o.object.type === 'shaer:Lapse') return;   // rendered below
      list.appendChild(offerCard(o));
    });
    lapses.forEach(function (l) { list.appendChild(lapseCard(l)); });
    gated.forEach(function (g) { list.appendChild(gatedCard(g)); });
    show('pending-section', offers.length > 0 || lapses.length > 0 || gated.length > 0);
  }

  // ── 4. Accepted wards: one panel per child ─────────────────────────────
  // A guardian thinks per child, not per function, so everything about one
  // child sits behind that child's row: the gated settings, the follow requests
  // waiting on them, their calls for help, their recent posts. The row itself
  // carries counts, so nothing that needs an answer hides inside a closed
  // panel.
  var openPanels = {};   // ward uri -> open, so a refresh does not close it
  // The follow requests and the wards' posts arrive from their own endpoints
  // and are grouped into the panels by ward, so they are cached here rather
  // than rendered into a section of their own.
  var FEED = [], FOLLOWS = [];

  function sectionInto(panel, title, items, empty, build) {
    var h = el('div', 'g-panel-sec');
    h.appendChild(el('h3', null, title));
    if (!items.length) h.appendChild(el('p', 'g-empty small', empty));
    else items.forEach(function (it) { h.appendChild(build(it)); });
    panel.appendChild(h);
    return h;
  }

  function gateButton(w, feature, current, proposeLabel, onLabel, offLabel) {
    var known = current === true || current === false;
    var btn = el('button', 'quiet small', (known ? (current ? onLabel : offLabel) : proposeLabel) || feature);
    btn.addEventListener('click', function () {
      btn.disabled = true;
      fetch('/guardian/wards/embeds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: w.other_uri, feature: feature, allow: known ? !current : true }),
      }).then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.state === 'open') {
            btn.textContent = (T.embeds_waiting || 'waiting for the other guardians');
            btn.disabled = true;
            return;
          }
          refresh();
        })
        .catch(function () { btn.disabled = false; });
    });
    return btn;
  }

  function embedsButton(w) {
    // Gated feature: external (non-fediverse) embeds. Off by default for a
    // ward; only a guardian can open it, and the gate is enforced server-side
    // when the feed is built, so this button is the only thing that moves it.
    // Shown for EVERY ward, including one on another server. There the value is
    // unknown (it lives on the ward's server), but proposing is exactly as
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
    return emb;
  }

  /**
   * The second step of releasing a ward: what it does, then yes or no.
   *
   * The warning is assembled from what the server found, not from a fixed
   * sentence, because releasing means two different things (FEP-633c): stepping
   * down while other guardians remain (§3.3), or being the last one, which is
   * emancipation and explicitly not one guardian's call (§3.4). And as long as
   * the Undo does not federate, the ward's server keeps listing you either way
   * — a guardian has to know that before pressing, not after.
   */
  function releaseStep(w, check, host, relBtn) {
    var uri = w.other_uri;
    var who = handleOf(uri, w.other_handle);
    var box = el('div', 'g-warn');
    box.appendChild(el('strong', null, (T.release_title || 'Release {who}?').replace('{who}', who)));
    box.appendChild(el('p', null, T.release_effect || ''));
    if (check.last === true) box.appendChild(el('p', 'grave', T.release_last || ''));
    else if (check.last === false) box.appendChild(el('p', null, T.release_step_down || ''));
    else box.appendChild(el('p', 'grave', T.release_unknown || ''));
    box.appendChild(el('p', null, T.release_local || ''));

    var row = el('div', 'row');
    var no = el('button', 'small', T.release_no || 'No');
    no.addEventListener('click', function () {
      host.removeChild(box);
      relBtn.hidden = false; relBtn.disabled = false;
    });
    // No first: the way out should be the easy one to hit.
    row.appendChild(no);
    // Being the last guardian is not a warning but a wall: the server refuses
    // it (§3.4), so offering a yes here would only produce an error. The text
    // above already says what has to happen instead.
    if (check.last !== true) {
      var yes = el('button', 'danger small', T.release_yes || 'Yes');
      yes.addEventListener('click', function () {
        yes.disabled = true;
        remove(uri, yes, function (err) {
          // The guardian set can change between the check and the click.
          yes.disabled = false;
          box.appendChild(el('p', 'grave', err === 'would_emancipate' ? (T.release_last || '') : (T.failed || '')));
          if (err === 'would_emancipate') yes.remove();
        });
      });
      row.appendChild(yes);
    }
    box.appendChild(row);
    return box;
  }

  /** The availability dot (FEP-633c 3.6): buddy-list language on the
   *  responsibility axis. Green available, yellow declared away with an end,
   *  grey observed dormant (one answer restores). */
  function availLabel(g) {
    if (g.availability === 'away') {
      var date = g.awayUntil ? new Date(g.awayUntil).toLocaleDateString() : '?';
      return (T.avail_away || 'Unavailable till {date}').replace('{date}', date);
    }
    if (g.availability === 'dormant') return T.avail_dormant || 'Offline';
    return T.avail_available || 'Available';
  }
  function availRow(g, wardUri) {
    var row = el('div', 'row g-guard');
    var dot = el('span', 'g-avdot ' + (g.availability === 'away' ? 'is-away' : g.availability === 'dormant' ? 'is-dormant' : 'is-active'));
    row.appendChild(dot);
    row.appendChild(el('span', 'who grow', handleOf(g.uri, g.handle)));
    row.appendChild(el('span', 'g-avlabel', availLabel(g)));
    // A dormant fellow guardian without a running lapse: the deliberate,
    // rare next step (3.6.3). Never shown for anyone still answering.
    if (g.availability === 'dormant' && !g.lapse && g.uri !== S.me) {
      var btn = el('button', 'quiet small', T.lapse_propose || 'Propose release');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        fetch('/guardian/api/lapse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ward: wardUri, target: g.uri, site: S.site }),
        }).then(refresh).catch(function () { btn.disabled = false; });
      });
      row.appendChild(btn);
    }
    return row;
  }

  function wardPanel(w) {
    var uri = w.other_uri;
    var panel = el('div', 'g-panel');
    panel.hidden = !openPanels[uri];

    var set = el('div', 'g-panel-sec');
    set.appendChild(el('h3', null, T.settings_title || 'Settings'));
    var setRow = el('div', 'row');
    setRow.appendChild(gateButton(w, 'shaer:externalEmbeds', w.embeds, T.embeds_propose, T.embeds_on, T.embeds_off));
    // The heavier sibling (5.6): seeing that a video exists is one decision,
    // letting a third party's player run inside the app is another. Hidden
    // only when previews are known-OFF: for a ward on another server the
    // value is unknown, and unknown is not off. Hiding it there meant a
    // guardian elsewhere could never even propose playback, which is how a
    // whole proposal round went into the wrong gate. The ward's server
    // enforces play-needs-previews at serve time regardless.
    if (w.embeds !== false) {
      setRow.appendChild(gateButton(w, 'shaer:externalPlayback', w.playback, T.play_propose, T.play_on, T.play_off));
    }
    set.appendChild(setRow);
    // What this guardian proposed and how it stands (5.6). This used to be a
    // button caption that vanished on refresh, so a running decision was
    // invisible: you could not tell "waiting", "done" and "expired" apart.
    (w.proposals || []).forEach(function (p) {
      var what = p.feature === 'shaer:externalPlayback' ? (T.prop_play || 'playback') : (T.prop_embeds || 'link previews');
      var line = (T.prop_line || 'Proposal {what} {value}: {status}')
        .replace('{what}', what)
        .replace('{value}', p.value ? (T.prop_on || 'on') : (T.prop_off || 'off'))
        .replace('{status}', T['prop_st_' + p.status] || p.status);
      set.appendChild(el('p', 'small g-prop g-prop-' + p.status, line));
    });
    panel.appendChild(set);

    // The fellow guardians of this child, with availability (3.6). For a
    // ward on another server the states live there, and saying so honestly
    // beats guessing.
    var gsec = el('div', 'g-panel-sec');
    gsec.appendChild(el('h3', null, T.panel_guards || 'Guardians of this child'));
    if (w.guardians && w.guardians.length) {
      w.guardians.forEach(function (g) { gsec.appendChild(availRow(g, uri)); });
    } else {
      // A ward on another server: WHO guards it is public on its actor
      // (shaer:guardians, 2.1), so list the seats; availability is the ward
      // server's private ledger (3.6.1) and is not shown, only named.
      var placeholder = el('p', 'g-empty small', '…');
      gsec.appendChild(placeholder);
      fetch('/guardian/wards/guardians?site=' + encodeURIComponent(S.site) + '&uri=' + encodeURIComponent(uri))
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (!j || !j.guardians || !j.guardians.length) {
            placeholder.textContent = T.panel_guards_remote || '';
            return;
          }
          placeholder.remove();
          j.guardians.forEach(function (g) {
            var row = el('div', 'row g-guard');
            row.appendChild(el('span', 'who grow', handleOf(g.uri, g.handle)));
            gsec.appendChild(row);
          });
          gsec.appendChild(el('p', 'g-empty small', T.panel_guards_far || ''));
        })
        .catch(function () { placeholder.textContent = T.panel_guards_remote || ''; });
    }
    panel.appendChild(gsec);

    sectionInto(panel, T.panel_follow || 'Follow requests',
      FOLLOWS.filter(function (f) { return f.wardUri === uri; }),
      T.panel_follow_empty || '', followCard);

    sectionInto(panel, T.panel_help || 'Calls for help',
      (S.help || []).filter(function (h) { return h.actor_uri === uri; }),
      T.panel_help_empty || '', helpCard);

    sectionInto(panel, T.panel_posts || 'Recent posts',
      FEED.filter(function (p) { return p.authorUri === uri; }),
      T.panel_posts_empty || '', feedCard);

    var act = el('div', 'g-panel-sec');
    act.appendChild(el('h3', null, T.panel_actions || 'Actions'));
    var actRow = el('div', 'row');
    var wave = el('button', 'small', T.wave || '👋 Wave');
    wave.addEventListener('click', function () { sendWave(uri, wave); });
    actRow.appendChild(wave);
    var rel = el('button', 'quiet small', T.release);
    // Letting a child go is a decision, not a click. It opens a step that first
    // asks the server what releasing this particular ward actually does, then
    // says it plainly and asks yes or no. Never window.confirm: that hides a
    // long explanation behind an OK button people press to make it go away.
    rel.addEventListener('click', function () {
      rel.disabled = true;
      // site matters: with several of your own sites the server would otherwise
      // check this ward against the wrong one and answer "not my ward".
      fetch('/guardian/wards/release-check?site=' + encodeURIComponent(S.site) + '&uri=' + encodeURIComponent(uri))
        .then(function (r) { return r.json(); })
        .then(function (c) {
          rel.hidden = true;
          act.appendChild(releaseStep(w, c || {}, act, rel));
        })
        .catch(function () { rel.disabled = false; });
    });
    actRow.appendChild(rel);
    act.appendChild(actRow);
    // Bovenaan, niet onderaan: zwaaien en loslaten zijn de dingen die je DOET.
    // De rest van het paneel is lezen -- instellingen, wie er nog meer op let,
    // wat er binnenkwam. Wie het paneel opent om iets te doen hoorde eerst langs
    // vijf secties te scrollen.
    panel.insertBefore(act, panel.firstChild);
    return panel;
  }

  function renderWards() {
    var list = document.getElementById('wards-list');
    list.textContent = '';
    var wards = S.wards || [];
    wards.forEach(function (w) {
      var uri = w.other_uri;
      var card = el('div', 'g-card ward');
      var row = el('div', 'row');
      row.appendChild(el('span', 'who grow', handleOf(uri, w.other_handle)));
      // Counts on the row: whatever is waiting must be visible with the panel shut.
      var nHelp = (S.help || []).filter(function (h) { return h.actor_uri === uri; }).length;
      var nFollow = FOLLOWS.filter(function (f) { return f.wardUri === uri; }).length;
      if (nHelp) row.appendChild(el('span', 'tag help', '🛟 ' + nHelp));
      if (nFollow) row.appendChild(el('span', 'tag co', nFollow + ' ' + (nFollow === 1 ? (T.badge_follow_one || '') : (T.badge_follow || ''))));
      row.appendChild(el('span', 'tag ok', T.active));
      var toggle = el('button', 'quiet small', openPanels[uri] ? T.panel_close : T.panel_open);
      row.appendChild(toggle);
      card.appendChild(row);
      var panel = wardPanel(w);
      card.appendChild(panel);
      toggle.addEventListener('click', function () {
        openPanels[uri] = !openPanels[uri];
        panel.hidden = !openPanels[uri];
        toggle.textContent = openPanels[uri] ? T.panel_close : T.panel_open;
      });
      list.appendChild(card);
    });
    show('wards-empty', wards.length === 0);
    // Step away (3.6.1) only means something with wards to tell.
    show('away-section', wards.length > 0);
  }

  // ── 4b. Step away (FEP-633c 3.6.1) ─────────────────────────────────────
  function declareAway(days, btn) {
    btn.disabled = true;
    fetch('/guardian/api/away', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: days, site: S.site }),
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        btn.disabled = false;
        var msg = document.getElementById('away-msg');
        msg.hidden = false;
        if (j && j.ok) {
          msg.className = 'g-msg';
          msg.textContent = (T.away_done || 'Your wards know you are unavailable until {date}.')
            .replace('{date}', new Date(j.until).toLocaleDateString());
        } else {
          msg.className = 'g-msg err';
          msg.textContent = (j && j.error) || (T.failed || 'failed');
        }
      })
      .catch(function () { btn.disabled = false; });
  }
  var awayWeek = document.getElementById('away-week');
  var awayMonth = document.getElementById('away-month');
  if (awayWeek) awayWeek.addEventListener('click', function () { declareAway(7, awayWeek); });
  if (awayMonth) awayMonth.addEventListener('click', function () { declareAway(30, awayMonth); });

  function sendWave(uri, btn) {
    btn.disabled = true;
    fetch('/guardian/api/wave', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ward: uri, site: S.site }),
    }).then(function (r) { return r.json(); })
      .then(function (j) { btn.disabled = false; btn.textContent = (j && j.ok) ? (T.waved || '👋 sent') : (T.wave || '👋 Wave'); })
      .catch(function () { btn.disabled = false; });
  }

  function remove(uri, btn, onError) {
    btn.disabled = true;
    fetch('/guardian/wards/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri: uri, site: S.site }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        // The server can refuse: emptying shaer:guardians is emancipation and
        // not one guardian's call (§3.4). Say so instead of silently redrawing.
        if (!res.ok) { if (onError) onError(res.j && res.j.error); return; }
        refresh();
      })
      .catch(function () { if (onError) onError('network'); else btn.disabled = false; });
  }

  function renderAll() { renderHelp(); renderPending(); renderWards(); }

  // ── 0. Wards' corner: read-only feed of your wards' posts ───────────────
  // Lives inside each child's panel now, so the fetches only fill a cache and
  // ask the ward list to redraw. A guardian watches, it does not publish.
  function feedCard(p) {
    var card = el('div', 'g-card feed');
    var head = el('div', 'row');
    head.appendChild(el('span', 'who grow', p.author));
    if (p.published) head.appendChild(el('span', 'g-when', when(p, p.published)));
    card.appendChild(head);
    var body = el('div', 'feed-body');
    // body_html is de gedeelde note-body-partial, serverside gerenderd: opmaak,
    // media, quote-kaart en embed, precies als in de Krant en in Berichten.
    // Valt terug op de kale content voor een client uit de cache.
    var html = p.body_html || p.content || '';
    if (p.cw) {
      // De content warning blijft van de PWA zelf: note-body versluiert alleen
      // bij nsfw, en een ward-post met alleen een cw hoort hier dicht te staan.
      var d = document.createElement('details');
      var sum = document.createElement('summary'); sum.textContent = p.cw; d.appendChild(sum);
      var inner = el('div'); inner.innerHTML = html; d.appendChild(inner);
      body.appendChild(d);
    } else {
      body.innerHTML = html;   // server-sanitized HTML (same as Berichten)
    }
    card.appendChild(body);
    return card;
  }

  function loadFeed() {
    return fetch('/guardian/api/feed?site=' + encodeURIComponent(S.site))
      .then(function (r) { return r.json(); })
      .then(function (f) { if (f && !f.error) { FEED = f.items || []; renderWards(); } })
      .catch(function () { /* panels just show "nothing yet" */ });
  }

  // ── 0b. Follow requests on your wards (§5.3) ────────────────────────────
  function answerFollow(id, decision, btn) {
    if (btn) btn.disabled = true;
    fetch('/guardian/api/follow/' + encodeURIComponent(id), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: decision, site: S.site }),
    }).then(loadFollowReqs);
  }
  function followCard(f) {
    var card = el('div', 'g-card');
    var row = el('div', 'row');
    // Inside the child's own panel the ward name is a given, so only the
    // person asking is named here.
    row.appendChild(el('span', 'who grow', f.follower));
    var ok = el('button', 'small', T.accept || 'Accept');
    ok.addEventListener('click', function () { answerFollow(f.id, 'approve', ok); });
    var no = el('button', 'quiet small', T.reject || 'Deny');
    no.addEventListener('click', function () { answerFollow(f.id, 'reject', no); });
    row.appendChild(ok); row.appendChild(no);
    card.appendChild(row);
    return card;
  }
  function loadFollowReqs() {
    return fetch('/guardian/api/follow-requests?site=' + encodeURIComponent(S.site))
      .then(function (r) { return r.json(); })
      .then(function (f) { if (f && !f.error) { FOLLOWS = f.items || []; renderWards(); } })
      .catch(function () { /* panels just show "none waiting" */ });
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

  // De push die de melding brengt is meteen het teken dat de staat veranderd is.
  // Daarmee hoeft er geen tweede, open verbinding bij: hetzelfde kanaal doet het
  // werk, en het werkt ook als de app dicht is.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.klonkt === 'push') refresh();
    });
  }
  // Het tikje blijft als vangnet -- niet elke verandering geeft een melding, en
  // niet iedereen heeft meldingen aanstaan. Maar niet tikken terwijl niemand
  // kijkt: dat waren verzoeken voor een tabblad op de achtergrond. Bij terugkomen
  // meteen een keer, want dan is de kans op nieuws het grootst.
  setInterval(function () { if (!document.hidden) refresh(); }, 45000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  } catch (e) {
    fatal((e && e.message) || String(e));
  }
})();
