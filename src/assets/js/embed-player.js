/**
 * Klonkt Embed Player — eigen, in-huisstijl media-embeds bovenop de ÉCHTE
 * player-API's (YouTube IFrame API, SoundCloud Widget API, Spotify iFrame API).
 *
 * De server (AudioEmbedService) rendert per embed een placeholder:
 *   <div class="folio-embed folio-embed--<provider> pcms-embed-card"
 *        data-embed-provider data-embed-ref data-embed-type data-embed-url></div>
 * Dit script bouwt daar onze eigen kaart omheen (cover/poster + onze play-knop +
 * voortgangsbalk in huisstijl) en bestuurt de onderliggende speler via de
 * platform-API, zodat play/pause/voortgang in ÓNZE handen liggen.
 *
 * Capability-eerlijkheid:
 *  - youtube/soundcloud  → volledig eigen controls (native chrome verborgen).
 *  - spotify             → besturing + onze frame eromheen; Spotify's eigen UI
 *                          blijft binnenin (kan niet anders zonder Premium+OAuth).
 *
 * Mutual exclusion: elke speler (incl. de site-audiospeler in audio-player.js)
 * registreert zich in window.pcmsMediaRegistry. Start er één → de vorige pauzeert.
 * Dit vervangt de oude focus/blur-heuristiek door echte play-events.
 *
 * Singleton — guard tegen dubbel-init (HTMX laadt scripts soms opnieuw).
 */
(function () {
  if (window.pcmsEmbedPlayer) return;

  // ============================================================
  // 0. Gedeelde playback-registry (ook door audio-player.js gebruikt)
  // ============================================================
  function registry() {
    if (window.pcmsMediaRegistry) return window.pcmsMediaRegistry;
    const r = {
      _active: null,
      // Markeer `player` als de enige actieve; pauzeer de vorige.
      setActive(player) {
        if (this._active && this._active !== player && this._active.pause) {
          try { this._active.pause(); } catch (e) {}
        }
        this._active = player;
      },
      release(player) { if (this._active === player) this._active = null; },
    };
    window.pcmsMediaRegistry = r;
    return r;
  }

  // ============================================================
  // 1. Lazy script-loaders — 1 promise per platform, gedeeld over N embeds.
  //    We laden een platform-script PAS als er een embed van dat platform op de
  //    pagina daadwerkelijk wordt gestart.
  // ============================================================
  const scripts = {};
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('embed-script faalde: ' + src));
      document.head.appendChild(s);
    });
  }
  // Belangrijk: alle loaders REJECTEN bij een script-fout (bv. een ad-blocker die
  // het API-script blokkeert) én na een time-out — zodat de aanroeper netjes kan
  // terugvallen op het kale platform-iframe i.p.v. eeuwig te hangen.
  const API_TIMEOUT = 8000;

  // YouTube: globale callback onYouTubeIframeAPIReady (1×) → in promise wikkelen.
  function ytApi() {
    if (scripts.yt) return scripts.yt;
    scripts.yt = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (e) {} }
        resolve(window.YT);
      };
      loadScript('https://www.youtube.com/iframe_api').catch(reject);
      setTimeout(() => reject(new Error('YT API timeout')), API_TIMEOUT);
    });
    return scripts.yt;
  }
  // SoundCloud: geen globale ready-callback; resolve op script-onload, daarna
  // wacht elke widget op z'n eigen SC.Widget.Events.READY.
  function scApi() {
    if (scripts.sc) return scripts.sc;
    scripts.sc = new Promise((resolve, reject) => {
      if (window.SC && window.SC.Widget) return resolve(window.SC);
      loadScript('https://w.soundcloud.com/player/api.js')
        .then(() => resolve(window.SC)).catch(reject);
      setTimeout(() => { (window.SC && window.SC.Widget) ? resolve(window.SC) : reject(new Error('SC API timeout')); }, API_TIMEOUT);
    });
    return scripts.sc;
  }
  // Spotify: globale callback onSpotifyIframeApiReady(IFrameAPI) (1×) → wrappen.
  function spotifyApi() {
    if (scripts.sp) return scripts.sp;
    scripts.sp = new Promise((resolve, reject) => {
      if (window.__spotifyIframeApi) return resolve(window.__spotifyIframeApi);
      window.onSpotifyIframeApiReady = function (IFrameAPI) {
        window.__spotifyIframeApi = IFrameAPI;
        resolve(IFrameAPI);
      };
      loadScript('https://open.spotify.com/embed/iframe-api/v1').catch(reject);
      // Korter dan API_TIMEOUT: Spotify's bundle initialiseert snel óf helemaal
      // niet (CDN 503 / origin-gating). Niet 8s wachten vóór de iframe-fallback.
      setTimeout(() => reject(new Error('Spotify API timeout')), 4000);
    });
    return scripts.sp;
  }

  // Kaal platform-iframe als fallback wanneer de JS-API geblokkeerd/onbereikbaar
  // is. Ad-blockers laten de embed-iframes doorgaans wél door. Autoplay-param
  // omdat we hier altijd in een user-gesture-context zitten (klik op play).
  function fallbackIframe(provider, ref, url) {
    if (provider === 'youtube') {
      const id = ytId(ref, url);
      return { src: 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?autoplay=1&rel=0', ratio: true, fs: true };
    }
    if (provider === 'soundcloud') {
      return { src: 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(ref || url) + '&auto_play=true&visual=true&hide_related=true', h: '300px' };
    }
    if (provider === 'spotify') {
      const m = (ref || '').match(/^spotify:(\w+):(\w+)$/);
      return { src: m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}` : (url || ''), h: '152px' };
    }
    return { src: url || '' };
  }

  // ============================================================
  // 2. Helpers
  // ============================================================
  function fmt(sec) {
    if (!sec || isNaN(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function ytId(ref, url) {
    if (ref && /^[A-Za-z0-9_-]{11}$/.test(ref)) return ref;
    const m = (url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    return null;  // geen blinde slice — een ongeldige ref geeft liever niets dan een kapotte id
  }
  // Alleen http(s) als href toelaten (defense-in-depth tegen javascript:/data:).
  function safeHref(u) {
    try { const p = new URL(u, location.href); return (p.protocol === 'http:' || p.protocol === 'https:') ? u : '#'; }
    catch (e) { return '#'; }
  }
  const ICON = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4l12 8-12 8z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h4v16H7zM13 4h4v16h-4z" fill="currentColor"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><path d="M16 8a5 5 0 010 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  };
  const LABEL = { youtube: 'YouTube', soundcloud: 'SoundCloud', spotify: 'Spotify' };

  // ============================================================
  // 3. Card controller — bouwt de huisstijl-kaart + delegeert naar een adapter
  // ============================================================
  function buildCard(el) {
    const provider = el.dataset.embedProvider;
    const ref = el.dataset.embedRef || '';
    const url = el.dataset.embedUrl || '';
    if (!provider) return;

    el.classList.add('pcms-embed-card', 'pcms-embed-card--' + provider);
    el.classList.remove('pcms-embed-loading');

    // Onze speler-zijde (registry-peer). pause() wijst naar de adapter zodra die
    // gemount is; ervoor is 't een no-op.
    let adapter = null;
    const self = { pause() { if (adapter && adapter.pause) { try { adapter.pause(); } catch (e) {} } } };

    // Teardown-hook: aangeroepen door de MutationObserver als deze kaart uit de
    // DOM verdwijnt (HTMX-swap) → adapter opruimen (timers/iframes) + registry
    // vrijgeven, zodat er geen poll-timers of spelers blijven lekken.
    el._pcmsDestroy = function () {
      try { if (adapter && adapter.destroy) adapter.destroy(); } catch (e) {}
      registry().release(self);
    };

    let playing = false;
    let mounted = false;
    let dur = 0;

    // --- UI ophangen (verschilt per provider-type) ---
    // Audio-only YouTube (data-embed-mode="audio"): render als audio-kaart met
    // onze controls; de YT-speler draait verborgen (off-screen) en levert alleen
    // het geluid. Video blijft de default.
    const audioOnly = provider === 'youtube' && el.dataset.embedMode === 'audio';
    if (audioOnly) el.classList.add('pcms-embed-audio-mode');
    const isVideo = provider === 'youtube' && !audioOnly;
    const custom = provider === 'youtube' || provider === 'soundcloud'; // eigen controls
    const poster = provider === 'youtube'
      ? `https://i.ytimg.com/vi/${ytId(ref, url)}/hqdefault.jpg` : '';

    el.innerHTML = ''
      + (isVideo
          ? `<div class="pcms-embed-stage"><div class="pcms-embed-mount"></div>`
            + `<button type="button" class="pcms-embed-poster"${poster ? ` style="background-image:url('${poster}')"` : ''} aria-label="Afspelen">`
            + `<span class="pcms-embed-bigplay">${ICON.play}</span></button></div>`
          : `<div class="pcms-embed-audio">`
            + `<button type="button" class="pcms-embed-art" aria-label="Afspelen"><span class="pcms-embed-bigplay">${ICON.play}</span></button>`
            + `<div class="pcms-embed-info"><div class="pcms-embed-title">${LABEL[provider] || provider}</div>`
            + `<div class="pcms-embed-sub"></div></div>`
            + `<div class="pcms-embed-mount"></div></div>`)
      + (custom
          ? `<div class="pcms-embed-bar">`
            + `<button type="button" class="pcms-embed-pp" aria-label="Afspelen/pauzeren">${ICON.play}</button>`
            + `<span class="pcms-embed-cur mono">0:00</span>`
            + `<div class="pcms-embed-seek" role="slider" aria-label="Voortgang" tabindex="0"><div class="pcms-embed-seek-fill"></div></div>`
            + `<span class="pcms-embed-dur mono">0:00</span>`
            + `<button type="button" class="pcms-embed-mute" aria-label="Dempen">${ICON.volume}</button>`
            + `<input type="range" class="pcms-embed-vol" min="0" max="100" value="100" aria-label="Volume">`
            + `<a class="pcms-embed-badge" href="${escAttr(safeHref(url))}" target="_blank" rel="noopener">${LABEL[provider] || provider}</a>`
            + `</div>`
          : `<div class="pcms-embed-frame-badge"><a href="${escAttr(safeHref(url))}" target="_blank" rel="noopener">via ${LABEL[provider] || provider}</a></div>`);

    const mountEl = el.querySelector('.pcms-embed-mount');
    const ppBtn = el.querySelector('.pcms-embed-pp');
    const curEl = el.querySelector('.pcms-embed-cur');
    const durEl = el.querySelector('.pcms-embed-dur');
    const seekEl = el.querySelector('.pcms-embed-seek');
    const seekFill = el.querySelector('.pcms-embed-seek-fill');
    const posterBtn = el.querySelector('.pcms-embed-poster, .pcms-embed-art');
    const subEl = el.querySelector('.pcms-embed-sub');
    const volEl = el.querySelector('.pcms-embed-vol');
    const muteBtn = el.querySelector('.pcms-embed-mute');
    let vol = 100;       // huidige volume 0-100 (wordt op de adapter toegepast)
    let preMuteVol = 100;
    // Audio-only YouTube: zet de thumbnail als albumhoes op de audio-kaart.
    if (audioOnly && poster) {
      const art0 = el.querySelector('.pcms-embed-art');
      if (art0) { art0.style.backgroundImage = `url('${poster}')`; art0.classList.add('has-art'); }
    }

    function setPlayingUI(on) {
      playing = on;
      el.classList.toggle('is-playing', on);
      if (ppBtn) ppBtn.innerHTML = on ? ICON.pause : ICON.play;
    }
    function setProgress(cur, total) {
      if (total > 0) { dur = total; if (durEl) durEl.textContent = fmt(total); }
      if (curEl) curEl.textContent = fmt(cur);
      if (seekFill && dur > 0) seekFill.style.width = Math.max(0, Math.min(100, (cur / dur) * 100)) + '%';
    }

    const hooks = {
      onReady(meta) {
        el.classList.add('is-ready');
        el.classList.remove('pcms-embed-busy');
        if (meta && meta.title && subEl) subEl.textContent = meta.title;
        if (meta && meta.artwork) {
          const art = el.querySelector('.pcms-embed-art');
          if (art) { art.style.backgroundImage = `url('${meta.artwork}')`; art.classList.add('has-art'); }
        }
        if (meta && meta.duration) setProgress(0, meta.duration);
      },
      onPlay() { setPlayingUI(true); registry().setActive(self); },
      onPause() { setPlayingUI(false); },
      onEnded() { setPlayingUI(false); setProgress(0, dur); registry().release(self); },
      onProgress(cur, total) { setProgress(cur, total); },
    };

    // API geblokkeerd/onbereikbaar → kaal platform-iframe (graceful degradation).
    // De mutual-exclusion loopt voor deze fallback via de blur-heuristiek
    // (audio-player.js), want de kaart krijgt geen .is-mounted.
    function renderFallback() {
      const fb = fallbackIframe(provider, ref, url);
      if (!fb.src) { el.classList.remove('pcms-embed-busy'); el.classList.add('pcms-embed-error'); return; }
      const iframe = document.createElement('iframe');
      iframe.src = fb.src;
      iframe.loading = 'lazy';
      iframe.title = LABEL[provider] || provider;
      iframe.setAttribute('allow', 'autoplay; encrypted-media; clipboard-write; picture-in-picture; fullscreen');
      if (fb.fs) iframe.allowFullscreen = true;
      iframe.style.cssText = fb.ratio
        ? 'width:100%;aspect-ratio:16/9;border:0;display:block;'
        : 'width:100%;height:' + (fb.h || '152px') + ';border:0;display:block;';
      el.classList.remove('is-mounted', 'pcms-embed-busy');
      el.classList.add('pcms-embed-fallback');
      el.innerHTML = '';
      el.appendChild(iframe);

      // Mutual exclusion óók voor de fallback-iframe. Een cross-origin iframe
      // kunnen we niet via een API pauzeren, dus 'pauze' = herladen ZONDER
      // autoplay (= stopt het geluid, speler blijft zichtbaar/herstartbaar).
      // We registreren 'm als actief: nu (= gebruiker start de embed) pauzeert de
      // site-speler/andere embeds; en als de site-speler later start, pauzeert de
      // registry deze fallback.
      self.pause = function () {
        try {
          const noAuto = fb.src
            .replace(/([?&])(?:autoplay=1|auto_play=true)(&|$)/gi, '$1')
            .replace(/[?&]$/, '');
          if (iframe.src === noAuto) {
            // src ongewijzigd (bv. Spotify zonder autoplay) → forceer een reload
            iframe.src = 'about:blank';
            setTimeout(() => { try { iframe.src = noAuto; } catch (e) {} }, 30);
          } else {
            iframe.src = noAuto;
          }
        } catch (e) {}
      };
      registry().setActive(self);
    }

    // Eerste interactie → adapter mounten + spelen. Daarna toggelt de knop.
    async function ensureMountedAndPlay() {
      if (mounted) { if (adapter) adapter.play(); return; }
      mounted = true;
      // Spotify: hun speler is toch niet te skinnen (besturing-only) én de
      // iFrame-API-bundle initialiseert in de praktijk vaak niet (CDN-gating/503)
      // → niet op de API wachten, meteen het kale Spotify-iframe tonen. Instant.
      if (provider === 'spotify') { renderFallback(); return; }
      el.classList.add('pcms-embed-busy');
      try {
        adapter = await MOUNTERS[provider](mountEl, { ref, url }, hooks);
        if (el._pcmsApplyVol) el._pcmsApplyVol();  // onthouden volume toepassen
        // is-mounted: CSS verbergt de poster (video) of de Spotify-facade en
        // toont de echte speler. Voor SoundCloud blijft onze kaart+balk staan en
        // blijft het (functionele) iframe off-screen verborgen.
        el.classList.add('is-mounted');
        adapter.play();
      } catch (err) {
        console.warn('[pcms-embed] API niet beschikbaar, val terug op kaal iframe', provider, err);
        renderFallback();
      }
    }

    if (posterBtn) posterBtn.addEventListener('click', ensureMountedAndPlay);
    if (ppBtn) ppBtn.addEventListener('click', () => {
      if (!mounted) return ensureMountedAndPlay();
      if (playing) { adapter && adapter.pause(); } else { adapter && adapter.play(); }
    });
    if (seekEl) seekEl.addEventListener('click', (e) => {
      if (!adapter || !adapter.seek || !dur) return;
      const rect = seekEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      adapter.seek(ratio * dur);
    });
    // Volume: schuif zet vol (0-100) en past 'm toe op de adapter (YT/SC hebben
    // setVolume). De waarde wordt onthouden en na het mounten opnieuw toegepast.
    function applyVol() {
      if (adapter && adapter.setVolume) { try { adapter.setVolume(vol); } catch (e) {} }
      if (muteBtn) muteBtn.innerHTML = vol === 0 ? ICON.muted : ICON.volume;
      if (volEl && String(volEl.value) !== String(vol)) volEl.value = vol;
      el.classList.toggle('is-muted', vol === 0);
    }
    if (volEl) volEl.addEventListener('input', () => { vol = parseInt(volEl.value, 10) || 0; if (vol > 0) preMuteVol = vol; applyVol(); });
    if (muteBtn) muteBtn.addEventListener('click', () => {
      if (vol > 0) { preMuteVol = vol; vol = 0; } else { vol = preMuteVol || 100; }
      applyVol();
    });
    el._pcmsApplyVol = applyVol;  // door ensureMountedAndPlay aangeroepen na mount
  }

  function escAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ============================================================
  // 4. Adapters — normaliseren de 3 zeer verschillende API's naar 1 vorm.
  //    Elke mounter geeft { play, pause, seek } terug en roept hooks aan met
  //    seconden (units worden hier rechtgetrokken).
  // ============================================================
  const MOUNTERS = {
    // ---- YouTube: IFrame Player API, eigen controls (controls:0) ----
    async youtube(mountEl, { ref, url }, hooks) {
      const YT = await ytApi();
      const id = ytId(ref, url);
      return new Promise((resolve, reject) => {
        let pollTimer = null;
        const player = new YT.Player(mountEl, {
          videoId: id,
          host: 'https://www.youtube-nocookie.com',
          playerVars: {
            controls: 0, modestbranding: 1, rel: 0, playsinline: 1, fs: 0,
            disablekb: 1, iv_load_policy: 3, origin: window.location.origin,
          },
          events: {
            onReady() {
              let d = 0; const meta = {};
              try { d = player.getDuration() || 0; } catch (e) {}
              try { const vd = player.getVideoData(); if (vd && vd.title) meta.title = vd.title; } catch (e) {}
              meta.duration = d;
              hooks.onReady(meta);
              resolve({
                play() { try { player.playVideo(); } catch (e) {} },
                pause() { try { player.pauseVideo(); } catch (e) {} },
                seek(sec) { try { player.seekTo(sec, true); } catch (e) {} },
                setVolume(pct) { try { if (pct <= 0) player.mute(); else { player.unMute(); player.setVolume(pct); } } catch (e) {} },
                destroy() {
                  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
                  try { player.destroy(); } catch (e) {}
                },
              });
            },
            onStateChange(e) {
              // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
              if (e.data === 1) {
                hooks.onPlay();
                if (!pollTimer) pollTimer = setInterval(() => {
                  try { hooks.onProgress(player.getCurrentTime() || 0, player.getDuration() || 0); } catch (e) {}
                }, 250);
              } else if (e.data === 2) {
                hooks.onPause();
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              } else if (e.data === 0) {
                hooks.onEnded();
                if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
              }
            },
            onError() { reject(new Error('YT error')); },
          },
        });
      });
    },

    // ---- SoundCloud: Widget API, visual=false, eigen controls ----
    async soundcloud(mountEl, { ref, url }, hooks) {
      const SC = await scApi();
      // Iframe zelf bouwen (kale balk) en daarna SC.Widget eraan hangen.
      const iframe = document.createElement('iframe');
      iframe.allow = 'autoplay';
      iframe.title = 'SoundCloud';
      const params = new URLSearchParams({
        url: ref || url, visual: 'false', auto_play: 'false', hide_related: 'true',
        show_comments: 'false', show_user: 'false', show_teaser: 'false',
        sharing: 'false', buy: 'false', download: 'false', show_artwork: 'true',
        single_active: 'true', color: 'ff5500',
      });
      iframe.src = 'https://w.soundcloud.com/player/?' + params.toString();
      mountEl.appendChild(iframe);
      const widget = SC.Widget(iframe);
      const E = SC.Widget.Events;
      return new Promise((resolve, reject) => {
        let resolved = false;
        widget.bind(E.READY, () => {
          widget.getCurrentSound((sound) => {
            const meta = sound ? {
              title: sound.title || '',
              artwork: (sound.artwork_url || (sound.user && sound.user.avatar_url) || '').replace('-large', '-t300x300'),
            } : {};
            widget.getDuration((ms) => { meta.duration = (ms || 0) / 1000; hooks.onReady(meta); });
          });
          resolved = true;
          resolve({
            play() { widget.play(); },
            pause() { widget.pause(); },
            seek(sec) { widget.seekTo(sec * 1000); },
            setVolume(pct) { try { widget.setVolume(pct); } catch (e) {} },
            destroy() {
              try { ['READY', 'PLAY', 'PAUSE', 'FINISH', 'PLAY_PROGRESS', 'ERROR'].forEach((k) => E[k] && widget.unbind(E[k])); } catch (e) {}
              try { iframe.remove(); } catch (e) {}
            },
          });
        });
        widget.bind(E.PLAY, () => hooks.onPlay());
        widget.bind(E.PAUSE, () => hooks.onPause());
        widget.bind(E.FINISH, () => hooks.onEnded());
        widget.bind(E.PLAY_PROGRESS, (d) => {
          hooks.onProgress((d.currentPosition || 0) / 1000, 0);
        });
        widget.bind(E.ERROR, () => { if (!resolved) reject(new Error('SC error')); });
        setTimeout(() => { if (!resolved) reject(new Error('SC timeout')); }, 12000);
      });
    },

    // ---- Spotify: iFrame API — besturing + onze frame; geen eigen skin ----
    async spotify(mountEl, { ref, url }, hooks) {
      const IFrameAPI = await spotifyApi();
      const uri = ref || url;
      return new Promise((resolve, reject) => {
        let lastPaused = true, resolved = false;
        IFrameAPI.createController(mountEl, { uri, width: '100%', height: 152 }, (controller) => {
          controller.addListener('ready', () => {
            hooks.onReady({});
            resolved = true;
            resolve({
              play() { try { controller.resume(); } catch (e) { try { controller.play(); } catch (e2) {} } },
              pause() { try { controller.pause(); } catch (e) {} },
              seek(sec) { try { controller.seek(sec); } catch (e) {} },
              destroy() { try { controller.destroy(); } catch (e) {} },
            });
          });
          controller.addListener('playback_update', (e) => {
            const d = e && e.data ? e.data : {};
            hooks.onProgress((d.position || 0) / 1000, (d.duration || 0) / 1000);
            // Geen betrouwbare 'ended'-event bij Spotify; we behandelen elke
            // isPaused-overgang als play/pause. Einde = gewoon een pauze (de balk
            // blijft op de eindpositie i.p.v. misleidend naar 0 te springen).
            if (d.isPaused === false && lastPaused) { lastPaused = false; hooks.onPlay(); }
            else if (d.isPaused === true && !lastPaused) { lastPaused = true; hooks.onPause(); }
          });
        });
        setTimeout(() => { if (!resolved) reject(new Error('Spotify timeout')); }, 12000);
      });
    },
  };

  // ============================================================
  // 5. Scan + HTMX-/DOM-mutatie-aware (de site navigeert deels via HTMX-swaps)
  // ============================================================
  function scan(root) {
    (root || document).querySelectorAll('.folio-embed[data-embed-provider]').forEach((el) => {
      if (el.dataset.embedInit) return;
      el.dataset.embedInit = '1';
      try { buildCard(el); } catch (e) { console.error('[pcms-embed] buildCard faalde', e); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document));
  } else {
    scan(document);
  }
  // HTMX vervangt #pcms-main bij interne navigatie → opnieuw scannen.
  document.body.addEventListener('htmx:afterSwap', (e) => scan(e.target || document));
  document.body.addEventListener('htmx:load', (e) => scan(e.target || document));

  // Teardown bij verwijdering uit de DOM (HTMX vervangt #pcms-main innerHTML, of
  // een SPA-achtige swap). Zonder dit blijven YouTube-poll-timers + adapters/
  // iframes hangen als je wegnavigeert terwijl een embed speelt → CPU/geheugenlek
  // dat per navigatie opstapelt. We roepen el._pcmsDestroy() aan voor elke kaart
  // die echt uit het document verdwijnt.
  const teardownObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      m.removedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const cards = [];
        if (node.matches && node.matches('.folio-embed[data-embed-init]')) cards.push(node);
        if (node.querySelectorAll) node.querySelectorAll('.folio-embed[data-embed-init]').forEach((c) => cards.push(c));
        cards.forEach((c) => {
          if (typeof c._pcmsDestroy === 'function' && !document.contains(c)) {
            try { c._pcmsDestroy(); } catch (e) {}
          }
        });
      });
    }
  });
  try { teardownObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

  window.pcmsEmbedPlayer = { scan, registry };
})();
