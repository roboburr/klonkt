// De posteditor -- verplaatst uit inline script, shaer-bqr.
//
// Zeven blokken, ruim 1000 regels. Alle servertekst komt uit pageData() en gaat
// door esc(): de EJS-tag ontsnapte die vroeger ook, dus dit is gedragsgelijk en
// het houdt een apostrof in een vertaling uit de HTML die hier geplakt wordt.

import { pageData, esc, makeSweeper } from './lib.js';

// De oude inline scripts draaiden bij ELKE render; een module draait zijn
// top-level een keer per sessie. Vandaar init(): de bootstrap roept hem aan
// bij elke paginawissel waarop deze module actief is, en de veger haalt eerst
// de document/window-listeners van de vorige pagina weg -- die overleven de
// swap, met closures naar elementen die al verdwenen zijn (shaer-5s1).
const doc = makeSweeper();
let T = {};
let _barObserver = null;

export function init() {
  doc.sweep();
  if (_barObserver) { _barObserver.disconnect(); _barObserver = null; }
  T = pageData();
  run();
}

function run() {

          (function () {
            var cb = document.getElementById('pe-fedi-audio'), w = document.getElementById('pe-fedi-audio-warn');
            if (cb && w && !cb.__wired) { cb.__wired = true; cb.addEventListener('change', function () { w.hidden = !cb.checked; }); }
          })();
          

// ── volgend blok ──

        (function () {
          var cw = document.getElementById('pe-cw'), nsfw = document.getElementById('pe-nsfw');
          // Typing a warning text implies the post is sensitive → auto-tick NSFW.
          if (cw && nsfw && !cw.__nsfwWired) { cw.__nsfwWired = true;
            cw.addEventListener('input', function () { if (cw.value.trim()) nsfw.checked = true; });
          }
        })();
        

// ── volgend blok ──

        (function () {
          var box = document.getElementById('pe-poll-fields');
          var tog = document.getElementById('pe-poll-toggle');
          var opts = document.getElementById('pe-poll-opts');
          var add = document.getElementById('pe-poll-add');
          if (!box || !opts) return;
          if (tog && !tog.__wired) { tog.__wired = true; tog.addEventListener('change', function () { box.style.display = tog.checked ? '' : 'none'; }); }
          var PH = opts.getAttribute('data-ph') || '', DEL = opts.getAttribute('data-del') || '';
          function rows() { return opts.querySelectorAll('.pe-poll-row'); }
          // A poll needs at least 2 options: hide the ✕ at the minimum, and cap adding at 8.
          function refresh() {
            var n = rows().length;
            opts.querySelectorAll('.pe-poll-del').forEach(function (b) { b.hidden = n <= 2; });
            if (add) add.disabled = n >= 8;
          }
          function makeRow() {
            var row = document.createElement('div'); row.className = 'pe-poll-row';
            var i = document.createElement('input'); i.type = 'text'; i.name = 'poll_option'; i.className = 'pe-poll-opt'; i.maxLength = 100; i.placeholder = PH;
            var d = document.createElement('button'); d.type = 'button'; d.className = 'pe-poll-del'; d.setAttribute('aria-label', DEL); d.title = DEL; d.innerHTML = '&times;';
            row.appendChild(i); row.appendChild(d); return row;
          }
          if (add && !add.__wired) { add.__wired = true; add.addEventListener('click', function () { if (rows().length >= 8) return; opts.appendChild(makeRow()); refresh(); }); }
          if (!opts.__wired) { opts.__wired = true; opts.addEventListener('click', function (e) { var d = e.target.closest('.pe-poll-del'); if (!d || rows().length <= 2) return; d.closest('.pe-poll-row').remove(); refresh(); }); }
          refresh();
        })();
        

// ── volgend blok ──

            (function(){ var p=document.getElementById('pe-paid'), box=document.getElementById('pe-paid-price');
              if (p&&box&&!p.__wired){ p.__wired=true; p.addEventListener('change', function(){ box.style.display=p.checked?'':'none'; }); } })();
          

// ── volgend blok ──

            (function () {
              var cb = document.getElementById('pe-sched-toggle');
              var box = document.getElementById('pe-sched-fields');
              if (!cb || !box) return;
              var inp = document.getElementById('pe-publish-at');
              var SITE_TZ = '' + (T._timezone || '') + ''; // configured site timezone; empty = browser local
              var pad = function (n) { return String(n).padStart(2, '0'); };
              // Offset (ms) between a timezone and UTC at a given moment.
              function tzOffset(date, tz) {
                var f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                var p = {}; f.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
                return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime();
              }
              // datetime-local "wall time" (in the site zone) → UTC Date.
              function wallToUtc(wall) {
                if (!SITE_TZ) return new Date(wall);
                var guess = new Date(wall + ':00Z').getTime();
                return new Date(guess - tzOffset(new Date(guess), SITE_TZ));
              }
              // UTC-ISO → "YYYY-MM-DDTHH:MM" wall time in the site zone.
              function utcToWall(iso) {
                var d = new Date(iso); if (isNaN(d)) return '';
                if (!SITE_TZ) return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
                var f = new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                var p = {}; f.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
                return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute;
              }
              // Prefill: stored UTC → wall time in the site zone.
              if (inp && inp.dataset.iso) inp.value = utcToWall(inp.dataset.iso);
              // "Scheduled for" in human-readable time in the site zone.
              var when = document.getElementById('pe-sched-when');
              if (when && when.dataset.iso) {
                var dw = new Date(when.dataset.iso);
                if (!isNaN(dw)) when.textContent = '⏳ ' + when.dataset.label + ' ' + dw.toLocaleString(undefined, SITE_TZ ? { timeZone: SITE_TZ } : undefined);
              }
              function sync() { box.style.display = cb.checked ? '' : 'none'; if (inp) inp.disabled = !cb.checked; }
              cb.addEventListener('change', sync); sync();
              // On save: wall time in the site zone → UTC-ISO via a hidden field.
              var form = cb.closest('form');
              if (form) {
                form.addEventListener('submit', function () {
                  if (inp) inp.removeAttribute('name');
                  var old = form.querySelector('input[data-pa-utc]');
                  if (old) old.remove();
                  if (cb.checked && inp && inp.value) {
                    var d2 = wallToUtc(inp.value);
                    if (!isNaN(d2)) {
                      var h = document.createElement('input');
                      h.type = 'hidden'; h.name = 'publish_at'; h.setAttribute('data-pa-utc', '');
                      h.value = d2.toISOString();
                      form.appendChild(h);
                    }
                  }
                });
              }
            })();
          

// ── volgend blok ──

(function() {

  // ── Cover upload ────────────────────────────────────────────────
  const coverField   = document.getElementById('cover-upload-field');
  const coverTrigger = document.getElementById('cover-upload-trigger');
  const coverUrl     = document.getElementById('cover-url-field');
  const coverVideo   = document.getElementById('cover-video-field');
  const coverStatus  = document.getElementById('cover-upload-status');
  const coverWrap    = document.getElementById('cover-preview-wrap');
  const coverImg     = document.getElementById('cover-preview-img');

  async function uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    const res = await fetch('/posts/upload-image', { method: 'POST', body: fd });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ('Upload failed (' + res.status + ')'));
    }
    return await res.json();   // {url, size, mime}
  }

  // ── Image editor (rotate / crop / mirror) ──────────
  // Lazy-load Cropper.js (locally vendored) on first use.
  let _cropperReady = null;
  function ensureCropper() {
    if (window.Cropper) return Promise.resolve();
    if (_cropperReady) return _cropperReady;
    _cropperReady = new Promise((resolve, reject) => {
      if (!document.querySelector('link[data-cropper-css]')) {
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = '/assets/vendor/cropper.min.css'; l.setAttribute('data-cropper-css', '');
        document.head.appendChild(l);
      }
      const s = document.createElement('script');
      s.src = '/assets/vendor/cropper.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('cropper load failed'));
      document.head.appendChild(s);
    });
    return _cropperReady;
  }

  // True for an animated WebP (VP8X chunk with the animation flag set) — like a GIF it must skip
  // the canvas editor, otherwise it'd be flattened to a single static frame.
  async function isAnimatedWebpFile(file) {
    if (!file || file.type !== 'image/webp') return false;
    try {
      const b = new Uint8Array(await file.slice(0, 40).arrayBuffer());
      return b.length >= 21 && String.fromCharCode(b[12], b[13], b[14], b[15]) === 'VP8X' && (b[20] & 0x02) !== 0;
    } catch (_) { return false; }
  }

  // Opens the editor for a chosen file; resolves with an edited File,
  // or null if the user cancels. Animated images (GIF / animated WebP) are NOT sent through the
  // canvas editor (they would become static) — those upload directly.
  async function openImageEditor(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;
    if (file.type === 'image/gif') return file;               // preserve animation
    if (await isAnimatedWebpFile(file)) return file;          // animated WebP → preserve animation
    try { await ensureCropper(); } catch (_) { return file; } // editor unavailable → upload directly

    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'imed-backdrop';
      back.innerHTML =
        '<div class="imed-modal" role="dialog" aria-modal="true" aria-label="' + esc(T.title) + '">' +
          '<div class="imed-stage"><img alt=""></div>' +
          '<div class="imed-tools">' +
            '<button type="button" data-act="rl" title="' + esc(T.rotate_left) + '">⟲</button>' +
            '<button type="button" data-act="rr" title="' + esc(T.rotate_right) + '">⟳</button>' +
            '<button type="button" data-act="fh" title="' + esc(T.flip_h) + '">⇆</button>' +
            '<button type="button" data-act="fv" title="' + esc(T.flip_v) + '">⇅</button>' +
            '<button type="button" data-act="zi" title="' + esc(T.zoom_in) + '">＋</button>' +
            '<button type="button" data-act="zo" title="' + esc(T.zoom_out) + '">－</button>' +
            '<button type="button" data-act="reset" title="' + esc(T.reset) + '">↺</button>' +
          '</div>' +
          '<div class="imed-actions">' +
            '<button type="button" data-act="cancel" class="pe-btn pe-btn-secondary">' + esc(T.cancel) + '</button>' +
            '<button type="button" data-act="apply" class="pe-btn pe-btn-primary">' + esc(T.apply) + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(back);
      const img = back.querySelector('img');
      const url = URL.createObjectURL(file);
      let cropper = null, sx = 1, sy = 1;

      function cleanup() {
        try { if (cropper) cropper.destroy(); } catch (_) {}
        URL.revokeObjectURL(url);
        back.remove();
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(null); } }
      document.addEventListener('keydown', onKey);

      img.onload = () => {
        cropper = new Cropper(img, { viewMode: 1, autoCropArea: 1, background: false, responsive: true });
      };
      img.onerror = () => { cleanup(); resolve(file); }; // could not load → upload the original
      img.src = url;

      back.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (e.target === back) { cleanup(); resolve(null); return; }
        if (!btn || !cropper) return;
        const a = btn.getAttribute('data-act');
        if (a === 'rl') cropper.rotate(-90);
        else if (a === 'rr') cropper.rotate(90);
        else if (a === 'fh') { sx = -sx; cropper.scaleX(sx); }
        else if (a === 'fv') { sy = -sy; cropper.scaleY(sy); }
        else if (a === 'zi') cropper.zoom(0.1);
        else if (a === 'zo') cropper.zoom(-0.1);
        else if (a === 'reset') { sx = 1; sy = 1; cropper.reset(); }
        else if (a === 'cancel') { cleanup(); resolve(null); }
        else if (a === 'apply') {
          const canvas = cropper.getCroppedCanvas({ maxWidth: 3000, maxHeight: 3000, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });
          const png = (file.type === 'image/png' || file.type === 'image/webp');
          const mime = png ? 'image/png' : 'image/jpeg';
          const ext = png ? '.png' : '.jpg';
          canvas.toBlob((blob) => {
            cleanup();
            if (!blob) { resolve(file); return; }
            const base = (file.name || 'afbeelding').replace(/\.[^.]+$/, '');
            resolve(new File([blob], base + ext, { type: mime }));
          }, mime, 0.92);
        }
      });
    });
  }

  function showCoverPreview(url) {
    if (!coverWrap || !coverImg) return;
    if (url) {
      coverImg.src = url;
      coverImg.hidden = false;
      coverWrap.removeAttribute('data-empty');
      const emptyIcon = coverWrap.querySelector('.pe-cover-empty');
      if (emptyIcon) emptyIcon.remove();
    } else {
      coverImg.hidden = true;
      coverImg.src = '';
      coverWrap.setAttribute('data-empty', '');
      if (!coverWrap.querySelector('.pe-cover-empty')) {
        const span = document.createElement('span');
        span.className = 'pe-cover-empty';
        span.textContent = '🖼';
        coverWrap.appendChild(span);
      }
    }
  }

  if (coverTrigger && coverField) {
    coverTrigger.addEventListener('click', () => coverField.click());
  }
  if (coverField) {
    coverField.addEventListener('change', async () => {
      if (!coverField.files[0]) return;
      const edited = await openImageEditor(coverField.files[0]);
      coverField.value = '';
      if (!edited) return; // cancelled
      coverStatus.classList.remove('is-error');
      coverStatus.textContent = '' + esc(T.js_uploading) + '';
      try {
        const j = await uploadImage(edited);
        coverUrl.value = j.url;
        if (coverVideo) coverVideo.value = j.video || ''; // muted loop MP4 for an animated cover
        showCoverPreview(j.url);
        coverStatus.textContent = (j.video ? '🎬 ' : '') + '' + esc(T.js_uploaded) + ' ✓';
        setTimeout(() => { coverStatus.textContent = ''; }, 2000);
      } catch (e) {
        coverStatus.classList.add('is-error');
        coverStatus.textContent = '' + esc(T.js_failed) + ': ' + e.message;
      }
    });
  }
  // Live-update preview when user pastes a URL manually
  if (coverUrl) {
    coverUrl.addEventListener('input', () => {
      const v = coverUrl.value.trim();
      if (v) showCoverPreview(v); else showCoverPreview('');
    });
  }

  // ── WYSIWYG editor (P58) ────────────────────────────────────────
  // Architecture:
  //   - Visible <div contenteditable> (`#content-editor`) is what the user
  //     types in; it shows real HTML (formatted, not raw markup).
  //   - Hidden <input name="content"> (`#content-hidden`) is what submits.
  //     On submit we serialize the editor's HTML into it, with shortcode
  //     chips reduced back to their [[track:UUID]]/[[album:Name]]/[[playlist:slug]] text.
  //   - Initial content comes from a <script type="application/json"> tag
  //     to avoid HTML-escape-into-DOM issues; we set innerHTML once on load
  //     and walk text nodes to render shortcode tokens as chips.
  const contentField  = document.getElementById('content-upload-field');
  const contentBtn    = document.getElementById('insert-image-btn');
  const contentStatus = document.getElementById('content-upload-status');
  const editor        = document.getElementById('content-editor');
  const hiddenField   = document.getElementById('content-hidden');
  const charCountEl   = document.getElementById('char-count');
  const initialEl     = document.getElementById('initial-content');
  const toolbar       = document.getElementById('pe-toolbar');
  const form          = editor && editor.closest('form');

  if (!editor) return;

  // Auto-focus the title only on desktop (mouse/trackpad). On touch this would
  // immediately open the keyboard when the editor opens — not desired.
  try {
    const titleInput = form && form.querySelector('input[name="title"]');
    if (titleInput && window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      titleInput.focus({ preventScroll: true });
    }
  } catch (_) {}

  // ── Shortcode chip rendering / serialization ────────────────────
  // Pattern matches [[track:UUID]] / [[album:any text]] / [[playlist:slug]]
  // — but we DON'T want to chipify text the user is mid-typing inside an
  // HTML attribute; since chipify only walks text nodes (never attribute
  // values) that's already safe.
  const SC_RE = /\[\[(track|album|playlist|embed):([^\]]+)\]\]/g;

  const SC_ICONS = {
    track:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
    album:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
    playlist: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="15" y2="18"/><polygon points="3 5 3 13 9 9"/></svg>',
    embed:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 9 15.5 12 10 15"/></svg>',
  };

  function chipLabel(kind, value) {
    if (kind === 'track') {
      // UUIDs are noisy — show a 6-char prefix for visual hint
      const v = String(value || '');
      return '' + esc(T.chip_track) + ' ' + (v.length > 8 ? v.slice(0, 6) + '…' : v);
    }
    if (kind === 'album')    return '' + esc(T.chip_album) + ' ' + value;
    if (kind === 'playlist') return '' + esc(T.chip_playlist) + ' ' + value;
    if (kind === 'embed') {
      const clean = String(value || '').replace(/^https?:\/\/(www\.)?/, '');
      return '▶ ' + (clean.length > 36 ? clean.slice(0, 34) + '…' : clean);
    }
    return value;
  }

  function makeChip(kind, value) {
    const span = document.createElement('span');
    span.className = 'sc-chip';
    span.contentEditable = 'false';
    span.setAttribute('data-sc', kind + ':' + value);
    span.innerHTML =
      '<span class="sc-chip-icon" aria-hidden="true">' + (SC_ICONS[kind] || '') + '</span>' +
      '<span class="sc-chip-label"></span>';
    span.querySelector('.sc-chip-label').textContent = chipLabel(kind, value);
    return span;
  }

  // Walk text nodes inside `root` and replace [[type:value]] tokens with chips.
  function chipifyShortcodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const targets = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      // Skip text inside existing chips (their .sc-chip-label is set via .textContent so the [[...]] text never appears)
      if (n.parentElement && n.parentElement.closest('.sc-chip')) continue;
      if (SC_RE.test(n.nodeValue)) targets.push(n);
      SC_RE.lastIndex = 0;
    }
    for (const node of targets) {
      const txt = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0;
      let m;
      SC_RE.lastIndex = 0;
      while ((m = SC_RE.exec(txt)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
        frag.appendChild(makeChip(m[1], m[2].trim()));
        last = m.index + m[0].length;
      }
      if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }

  // Inverse of chipify: clone the editor, replace every chip with its text.
  function serializeChips(rootClone) {
    const chips = rootClone.querySelectorAll('.sc-chip[data-sc]');
    for (const c of chips) {
      const txt = '[[' + c.getAttribute('data-sc') + ']]';
      c.replaceWith(document.createTextNode(txt));
    }
  }

  // ── Boot: load initial content as HTML, then render shortcodes as chips
  try {
    const initial = JSON.parse(initialEl.textContent || '""');
    editor.innerHTML = initial || '';
    chipifyShortcodes(editor);
  } catch (e) {
    console.error('[editor] could not parse initial content', e);
    editor.innerHTML = '';
  }

  // ── Char counter
  function updateCharCount() {
    const text = (editor.innerText || '').replace(/\s+/g, ' ').trim();
    if (charCountEl) charCountEl.textContent = String(text.length);
  }
  updateCharCount();
  editor.addEventListener('input', updateCharCount);

  // ── Toolbar wiring
  // Lock the scroll position around an edit command. execCommand/insert scrolls
  // the caret into view by default → the view "jumps" when clicking a formatting
  // button. We lock ALL scrollable ancestors (editor, frame, #pcms-main, …)
  // + the page and restore them — sync and over a few frames, because Chrome
  // sometimes scrolls a frame later. The user scrolls themselves.
  function scrollableAncestors(el) {
    const list = [];
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') list.push(node);
      node = node.parentElement;
    }
    return list;
  }
  function keepScroll(fn) {
    // In fullscreen the page is locked (body overflow:hidden) and the field may
    // scroll to the caret freely — no page jump possible, so nothing to fix.
    const frame = document.querySelector('.pe-editor-frame');
    if (frame && frame.classList.contains('pe-fs')) { fn(); return; }
    const wx = window.scrollX, wy = window.scrollY;
    const anc = scrollableAncestors(editor).map(function (n) { return [n, n.scrollTop, n.scrollLeft]; });
    const restore = function () {
      window.scrollTo(wx, wy);
      anc.forEach(function (e) { e[0].scrollTop = e[1]; e[0].scrollLeft = e[2]; });
    };
    fn();
    restore();
    requestAnimationFrame(restore);
  }
  function execCmd(cmd, arg) {
    keepScroll(function () {
      editor.focus({ preventScroll: true });
      document.execCommand(cmd, false, arg);
    });
    updateToolbarState();
    updateCharCount();
  }
  function wrapCode() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    keepScroll(function () {
      const range = sel.getRangeAt(0);
      const code = document.createElement('code');
      code.textContent = sel.toString();
      range.deleteContents();
      range.insertNode(code);
      // Move caret after the new node
      range.setStartAfter(code);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      editor.focus({ preventScroll: true });
    });
  }
  function linkPrompt() {
    const url = window.prompt('' + esc(T.js_link_prompt) + '');
    if (!url) return;
    execCmd('createLink', url);
  }
  // Is the current selection inside a <blockquote> within the editor? Return it.
  function blockquoteAncestor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.anchorNode;
    while (node && node !== editor) {
      if (node.nodeType === 1 && node.tagName === 'BLOCKQUOTE') return node;
      node = node.parentNode;
    }
    return null;
  }
  // Real toggle: execCommand('formatBlock','blockquote') does turn it ON but
  // can never turn it OFF (browser quirk). If the caret is already in a quote →
  // unwrap it; otherwise apply blockquote.
  function toggleBlockquote() {
    keepScroll(function () {
      editor.focus({ preventScroll: true });
      const bq = blockquoteAncestor();
      if (bq) {
        const parent = bq.parentNode;
        // Extract content from the quote in place, then remove the empty wrapper.
        const ref = bq;
        let firstMoved = null;
        while (bq.firstChild) {
          const child = bq.firstChild;
          if (!firstMoved) firstMoved = child;
          parent.insertBefore(child, ref);
        }
        parent.removeChild(bq);
        // Restore the caret inside the unwrapped content.
        if (firstMoved) {
          const sel = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(firstMoved.nodeType === 1 ? firstMoved : parent);
          range.collapse(false);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else {
        document.execCommand('formatBlock', false, 'blockquote');
      }
    });
    updateToolbarState();
    updateCharCount();
  }

  if (toolbar) {
    // CRUCIAL (mobile + desktop): prevent a toolbar button from stealing focus/selection
    // from the editor field. Without this the selection is lost on tap
    // → execCommand operates on an empty selection (bold can no longer be toggled OFF)
    // and the browser scrolls the caret back into view (the "jump down"). preventDefault
    // on mousedown keeps focus in the editor; the click still fires normally.
    toolbar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    toolbar.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      e.preventDefault();
      const cmd = btn.dataset.cmd;
      const arg = btn.dataset.arg || null;
      if (cmd === 'link-prompt') linkPrompt();
      else if (cmd === 'code-wrap') wrapCode();
      else if (cmd === 'formatBlock' && arg === 'blockquote') toggleBlockquote();
      else execCmd(cmd, arg);
    });
  }

  // ── Full-screen writing mode: the writing field fills the whole page.
  const fsBtn = document.getElementById('pe-fullscreen-btn');
  const editorFrame = document.querySelector('.pe-editor-frame');
  const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  // OP TOUCH IS DIT GEEN LUXE MAAR DE ENIGE INGANG (shaer-kd1). Buiten
  // fullscreen is de toolbar daar verborgen (@media (pointer: coarse) in
  // pages/post-edit.ejs), en het veld staat op contenteditable=false. Ontbreekt
  // een van deze twee elementen, dan kun je op een telefoon NIET TYPEN -- en tot
  // nu toe gebeurde dat zonder één spoor: applyFs deed een kale `return`.
  if (isTouch && (!editorFrame || !editor)) {
    console.warn('[post-edit] fullscreen onbereikbaar op touch:',
      'frame=' + !!editorFrame, 'editor=' + !!editor,
      '-- de toolbar is hier verborgen, dus dit betekent: niet kunnen typen');
  }

  // On mobile the keyboard pushes the visible (visual) viewport up while
  // a position:fixed frame stays pinned to the LAYOUT viewport → the toolbar
  // slides out of view. Keep the fullscreen frame aligned to the visual
  // viewport (top + height) so the toolbar stays visible at the top.
  function syncFsViewport() {
    if (!editorFrame || !editorFrame.classList.contains('pe-fs')) return;
    const vv = window.visualViewport;
    if (!vv) return;
    editorFrame.style.top = vv.offsetTop + 'px';
    editorFrame.style.height = vv.height + 'px';
  }
  function clearFsViewport() {
    if (!editorFrame) return;
    editorFrame.style.top = '';
    editorFrame.style.height = '';
  }
  function isFs() { return !!(editorFrame && editorFrame.classList.contains('pe-fs')); }
  function applyFs(on) {
    if (!editorFrame) {
      // Was een kale `return`. Op touch is dit het verschil tussen "fullscreen
      // werkt niet" en "je kunt niet typen", en het gebeurde zonder spoor.
      console.warn('[post-edit] fullscreen kan niet: .pe-editor-frame ontbreekt');
      return;
    }
    editorFrame.classList.toggle('pe-fs', on);
    document.body.classList.toggle('pe-fs-open', on);
    document.documentElement.classList.toggle('pe-fs-open', on);
    if (fsBtn) {
      fsBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      fsBtn.title = on ? '' + esc(T.tb_done) + '' : '' + esc(T.tb_fullscreen) + '';
    }
    if (window.visualViewport) {
      if (on) {
        window.visualViewport.addEventListener('resize', syncFsViewport);
        window.visualViewport.addEventListener('scroll', syncFsViewport);
        syncFsViewport();
      } else {
        window.visualViewport.removeEventListener('resize', syncFsViewport);
        window.visualViewport.removeEventListener('scroll', syncFsViewport);
        clearFsViewport();
      }
    }
    // On touch the field is NOT editable inline; only in fullscreen.
    if (isTouch) editor.setAttribute('contenteditable', on ? 'true' : 'false');
    if (on) {
      editor.focus({ preventScroll: true });
    } else {
      if (isTouch) editor.blur();
      // On close: scroll to the TOP of the content instead of staying
      // somewhere at the bottom (footer).
      requestAnimationFrame(function () {
        try { editorFrame.scrollIntoView({ block: 'start' }); } catch (_) {}
      });
    }
  }
  // The fullscreen writing "page": opening pushes a history state so the browser
  // back button (and the Done button) closes it and returns you to the form — feels
  // like a separate page, but all form fields remain intact (same DOM).
  function openFs() {
    if (isFs()) return;
    try { history.pushState({ peFs: true }, ''); } catch (_) {}
    applyFs(true);
  }
  function closeFs() {
    if (!isFs()) return;
    if (history.state && history.state.peFs) history.back(); // → popstate closes it
    else applyFs(false);
  }
  function toggleFullscreen() { if (isFs()) closeFs(); else openFs(); }
  doc.on(window, 'popstate', function () { if (isFs()) applyFs(false); });
  // __wired zoals overal in run(): init() draait bij ELKE paginawissel, en op
  // dezelfde DOM zou een kale addEventListener stapelen. Na een htmx-wissel is
  // het element nieuw en dus de vlag weg -- precies de bedoeling.
  if (fsBtn && !fsBtn.__fsWired) { fsBtn.__fsWired = true; fsBtn.addEventListener('click', toggleFullscreen); }
  var fsDoneBtn = document.getElementById('pe-fs-done');
  if (fsDoneBtn && !fsDoneBtn.__fsWired) { fsDoneBtn.__fsWired = true; fsDoneBtn.addEventListener('click', closeFs); }
  doc.on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && isFs()) { e.preventDefault(); closeFs(); }
  });

  // On mobile/tablet (touch): the content field is NOT editable inline — it is
  // not a text field there. One tap → fullscreen, where it becomes editable
  // (toggleFullscreen toggles contenteditable). This prevents inline typing.
  if (isTouch && editor && !editor.__fsTapWired) {
    editor.__fsTapWired = true;
    editor.setAttribute('contenteditable', 'false');
    editor.classList.add('pe-tap-to-edit');
    editor.addEventListener('click', function () {
      if (!isFs()) openFs();
    });
  }

  // Reflect bold/italic/list state on the toolbar buttons
  function updateToolbarState() {
    if (!toolbar) return;
    const cmds = ['bold', 'italic', 'underline', 'insertUnorderedList', 'insertOrderedList'];
    for (const cmd of cmds) {
      const btn = toolbar.querySelector('button[data-cmd="' + cmd + '"]');
      if (!btn) continue;
      try { btn.classList.toggle('is-active', document.queryCommandState(cmd)); } catch(_) {}
    }
    // Quote button: active when the caret is inside a <blockquote> (toggle feedback).
    const bqBtn = toolbar.querySelector('button[data-cmd="formatBlock"][data-arg="blockquote"]');
    if (bqBtn) bqBtn.classList.toggle('is-active', !!blockquoteAncestor());
  }
  doc.on(document, 'selectionchange', () => {
    if (document.activeElement === editor) updateToolbarState();
  });

  // Keyboard shortcuts: Ctrl/Cmd + B/I/U/K
  editor.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); execCmd('bold'); }
    else if (k === 'i') { e.preventDefault(); execCmd('italic'); }
    else if (k === 'u') { e.preventDefault(); execCmd('underline'); }
    else if (k === 'k') { e.preventDefault(); linkPrompt(); }
  });

  // Paste: keep it simple — strip formatting unless user wants it. Default
  // execCommand 'paste' includes Word/Google-Docs garbage. We accept inline
  // styles from clipboard only when shift is held — otherwise plain text.
  editor.addEventListener('paste', (e) => {
    if (e.shiftKey) return; // user wants formatted paste
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (text == null) return;
    e.preventDefault();
    document.execCommand('insertText', false, text);
  });

  // ── Image upload (button + drag-drop into the editor)
  async function uploadAndInsertImage(file) {
    const edited = await openImageEditor(file);
    if (!edited) return; // cancelled
    contentStatus.classList.remove('is-error');
    contentStatus.textContent = '' + esc(T.js_uploading) + '';
    try {
      const j = await uploadImage(edited);
      const img = '<img src="' + j.url + '" alt="">';
      editor.focus({ preventScroll: true });
      document.execCommand('insertHTML', false, img);
      contentStatus.textContent = '' + esc(T.js_inserted) + ' ✓';
      setTimeout(() => { contentStatus.textContent = ''; }, 2000);
      updateCharCount();
    } catch (e) {
      contentStatus.classList.add('is-error');
      contentStatus.textContent = '' + esc(T.js_failed) + ': ' + e.message;
    }
  }

  if (contentBtn && contentField) {
    contentBtn.addEventListener('click', () => contentField.click());
    contentField.addEventListener('change', () => {
      if (contentField.files[0]) uploadAndInsertImage(contentField.files[0]);
      contentField.value = '';
    });

    editor.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        editor.classList.add('is-dragover');
      }
    });
    editor.addEventListener('dragleave', () => editor.classList.remove('is-dragover'));
    editor.addEventListener('drop', async (e) => {
      editor.classList.remove('is-dragover');
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      e.preventDefault();
      for (const f of files) {
        if (f.type.startsWith('image/')) await uploadAndInsertImage(f);
      }
    });
  }

  // ── Insert chip helpers (track / playlist)
  function insertChip(kind, value) {
    editor.focus({ preventScroll: true });
    const chip = makeChip(kind, value);
    // Insert at caret using the Selection API (execCommand insertNode)
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(chip);
      // Insert a trailing space so the user can keep typing after the chip
      const space = document.createTextNode('\u00A0');
      chip.after(space);
      range.setStartAfter(space);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      editor.appendChild(chip);
      editor.appendChild(document.createTextNode('\u00A0'));
    }
    updateCharCount();
  }

  // ── Embed insert: paste a platform URL -> [[embed:url]]-chip that becomes
  //    an iframe server-side (YouTube/Spotify/SoundCloud/Vimeo/Apple Music/Bandcamp).
  const embedBtn = document.getElementById('insert-embed-btn');
  if (embedBtn) {
    embedBtn.addEventListener('click', () => {
      const raw = window.prompt('' + esc(T.js_embed_prompt) + '');
      if (!raw) return;
      const url = raw.trim();
      if (!/^https?:\/\//i.test(url)) { alert('' + esc(T.js_embed_invalid) + ''); return; }
      insertChip('embed', url);
    });
  }

  // ── Track insert: opens the track-picker modal (P59)
  const trackBtn = document.getElementById('insert-track-btn');
  const trackPicker = document.getElementById('track-picker');
  if (trackBtn && trackPicker) {
    const tpList   = document.getElementById('tp-list');
    const tpEmpty  = document.getElementById('tp-empty');
    const tpSearch = document.getElementById('tp-search');
    let tpCache = null;       // cached track list (fetched once per page load)
    let tpLastFocus = null;   // element to restore focus to on close

    const SVG_NOTE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17V5l12-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="18" cy="15" r="3"/></svg>';

    function fmtDur(sec) {
      sec = Math.max(0, Math.floor(sec || 0));
      const m = Math.floor(sec / 60), s = sec % 60;
      return m + ':' + String(s).padStart(2, '0');
    }
    function escAttr(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
      }[c]));
    }

    function renderList(filter) {
      if (!Array.isArray(tpCache)) return;
      const q = (filter || '').trim().toLowerCase();
      const filtered = q
        ? tpCache.filter(t =>
            (t.title  || '').toLowerCase().includes(q) ||
            (t.artist || '').toLowerCase().includes(q))
        : tpCache;

      if (!filtered.length) {
        tpList.innerHTML = '';
        tpEmpty.textContent = q ? '' + esc(T.js_no_tracks_found) + ' ' + q : '' + esc(T.js_no_tracks_yet) + '';
        tpList.appendChild(tpEmpty);
        return;
      }

      tpList.innerHTML = filtered.map(t => {
        const cov = t.cover
          ? '<span class="tp-cover" style="background-image:url(\'' + escAttr(t.cover) + '\')"></span>'
          : '<span class="tp-cover tp-cover-empty">' + SVG_NOTE + '</span>';
        const dis = t.playable ? '' : ' aria-disabled="true"';
        const sub = t.artist ? '<span class="tp-row-artist">' + escAttr(t.artist) + '</span>' : '';
        return (
          '<button type="button" class="tp-row" role="option" data-track-id="' + escAttr(t.id) + '"' + dis + '>' +
            cov +
            '<span class="tp-meta">' +
              '<span class="tp-row-title">' + escAttr(t.title) + '</span>' +
              sub +
            '</span>' +
            '<span class="tp-duration">' + fmtDur(t.duration) + '</span>' +
          '</button>'
        );
      }).join('');
    }

    async function loadTracks() {
      if (Array.isArray(tpCache)) return tpCache;
      tpEmpty.textContent = '' + esc(T.js_tracks_loading) + '';
      try {
        const r = await fetch('/admin/playlists/api/tracks', { credentials: 'same-origin' });
        const j = await r.json();
        tpCache = (j && j.ok && Array.isArray(j.tracks)) ? j.tracks : [];
      } catch (e) {
        tpCache = [];
        tpEmpty.textContent = '' + esc(T.js_tracks_load_fail) + ': ' + e.message;
      }
      return tpCache;
    }

    function openPicker() {
      tpLastFocus = document.activeElement;
      trackPicker.hidden = false;
      trackPicker.setAttribute('aria-hidden', 'false');
      document.body.classList.add('tp-locked');
      tpSearch.value = '';
      renderList('');
      // Defer focus so the open animation doesn't get jumped
      setTimeout(() => tpSearch.focus(), 30);
    }
    function closePicker() {
      trackPicker.hidden = true;
      trackPicker.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('tp-locked');
      if (tpLastFocus && typeof tpLastFocus.focus === 'function') {
        try { tpLastFocus.focus(); } catch(_) {}
      }
    }

    trackBtn.addEventListener('click', async () => {
      openPicker();
      await loadTracks();
      renderList(tpSearch.value);
    });

    // Close: backdrop click, [data-tp-close], or Escape
    trackPicker.addEventListener('click', (e) => {
      if (e.target.closest('[data-tp-close]')) {
        closePicker();
        return;
      }
      const row = e.target.closest('.tp-row[data-track-id]');
      if (row) {
        if (row.getAttribute('aria-disabled') === 'true') return;
        const id = row.dataset.trackId;
        if (id) {
          insertChip('track', id);
          closePicker();
        }
      }
    });
    doc.on(document, 'keydown', (e) => {
      if (!trackPicker.hidden && e.key === 'Escape') {
        e.preventDefault();
        closePicker();
      }
    });

    // Live filter
    tpSearch.addEventListener('input', () => renderList(tpSearch.value));
  }

  // ── Playlist insert (open existing or create new via modal)
  const playlistBtn = document.getElementById('insert-playlist-btn');
  if (playlistBtn) {
    playlistBtn.addEventListener('click', async () => {
      if (typeof window.openPlaylistEditor !== 'function') {
        alert('' + esc(T.js_playlist_editor_missing) + '');
        return;
      }
      try {
        const r = await fetch('/admin/playlists/api/list', { credentials: 'same-origin' });
        const j = await r.json();
        if (j.ok && Array.isArray(j.playlists) && j.playlists.length > 0) {
          const choice = prompt(
            '' + esc(T.js_playlist_existing) + '\n\n' +
            j.playlists.map((p, i) => `${i + 1}. ${p.title} (${p.track_count} tracks)`).join('\n') +
            '\n\n' + esc(T.js_playlist_choose) + ''
          );
          if (choice && /^\d+$/.test(choice.trim())) {
            const idx = parseInt(choice.trim(), 10) - 1;
            if (idx >= 0 && idx < j.playlists.length) {
              insertChip('playlist', j.playlists[idx].id);
              return;
            }
          }
          if (choice === null) return;
        }
      } catch (_) { /* fall through to create */ }

      window.openPlaylistEditor({
        mode: 'create',
        onSaved: ({ id }) => insertChip('playlist', id),
      });
    });
  }

  // ── Post type: segmented control + type-aware panels ──────────
  (function () {
    const typeInput = document.getElementById('pe-type-input');
    const card = document.querySelector('.pe-type-card');
    if (!typeInput || !card) return;
    const seg = card.querySelector('.pe-typeseg');
    const panels = card.querySelectorAll('.pe-type-panel');

    function applyType(tt) {
      typeInput.value = tt;
      seg.querySelectorAll('.pe-typeseg-btn').forEach(b => {
        const on = b.dataset.type === tt;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      // data-panel mag meerdere types noemen: Album en Playlist delen het
      // muziekpaneel, want het verschil zit in de playlist en niet in de upload.
      panels.forEach(p => {
        const voor = String(p.dataset.panel || '').trim().split(/\s+/);
        p.hidden = !voor.includes(tt);
      });
    }
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('.pe-typeseg-btn');
      if (btn) applyType(btn.dataset.type);
    });
    applyType(typeInput.value || 'post');

    // Video URL → [[embed:url]] chip
    const vBtn = document.getElementById('pe-video-insert');
    const vUrl = document.getElementById('pe-video-url');
    if (vBtn && vUrl) {
      const doInsert = () => {
        const url = (vUrl.value || '').trim();
        if (!/^https?:\/\//i.test(url)) { alert('' + esc(T.js_embed_invalid) + ''); return; }
        insertChip('embed', url);
        vUrl.value = '';
      };
      vBtn.addEventListener('click', doInsert);
      vUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doInsert(); } });
    }

    // Audio: inline upload → transcodes server-side → [[track:id]] chip
    const drop = document.getElementById('pe-audio-drop');
    const fileInput = document.getElementById('pe-audio-file');
    const list = document.getElementById('pe-audio-list');
    if (drop && fileInput && list) {
      const pick = () => fileInput.click();
      drop.addEventListener('click', pick);
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-drag'); }));
      ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-drag'); }));
      drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files); });
      fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

      function clientDuration(f) {
        return new Promise((resolve) => {
          try {
            const u = URL.createObjectURL(f);
            const a = document.createElement('audio');
            a.preload = 'metadata';
            a.onloadedmetadata = () => { URL.revokeObjectURL(u); resolve(Number.isFinite(a.duration) ? Math.round(a.duration) : null); };
            a.onerror = () => { URL.revokeObjectURL(u); resolve(null); };
            a.src = u;
          } catch (_) { resolve(null); }
        });
      }
      async function handleFiles(files) {
        for (const f of Array.from(files || [])) await uploadOne(f);
      }
      async function uploadOne(f) {
        const li = document.createElement('li');
        li.className = 'pe-audio-item';
        const nameEl = document.createElement('span');
        nameEl.className = 'pe-audio-item-name';
        nameEl.textContent = f.name;
        const stateEl = document.createElement('span');
        stateEl.className = 'pe-audio-item-state';
        stateEl.textContent = '⏳ ' + esc(T.audio_up_busy) + '';
        li.appendChild(nameEl); li.appendChild(stateEl);
        list.appendChild(li);
        try {
          const dur = await clientDuration(f);
          const fd = new FormData();
          fd.append('audio', f);
          if (dur) fd.append('duration', String(dur));
          const res = await fetch('/admin/audio/upload', {
            method: 'POST', body: fd,
            headers: { 'Accept': 'application/json' },
            credentials: 'same-origin',
          });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.ok || !j.id) throw new Error(j.error || ('HTTP ' + res.status));
          insertChip('track', j.id);
          stateEl.textContent = '✓ ' + esc(T.audio_up_done) + '';
          li.classList.add('is-done');
        } catch (err) {
          stateEl.textContent = '✕ ' + esc(T.audio_up_fail) + ': ' + err.message;
          li.classList.add('is-fail');
        }
      }
    }
  })();

  // ── Submit: serialize editor contents into the hidden field
  if (form && hiddenField) {
    form.addEventListener('submit', () => {
      const clone = editor.cloneNode(true);
      serializeChips(clone);
      hiddenField.value = clone.innerHTML;
    });
  }
})();

// ── volgend blok ──

(function () {
  // Pin: checkbox toggles the hidden rank field (0 = not pinned),
  // ▲▼ shifts the position, with a readable description instead of a raw number.
  var toggle = document.getElementById('pin-toggle');
  var rank   = document.getElementById('pin-rank');
  var pos    = document.getElementById('pin-pos');
  var label  = document.getElementById('pin-label');
  var up     = document.getElementById('pin-up');    // higher = lower number (towards 1/top)
  var down   = document.getElementById('pin-down');
  if (!toggle || !rank || !pos) return;

  function descr(n) {
    n = Number(n) || 0;
    if (n <= 1) return '' + esc(T.pin_top) + '';
    return n + '' + esc(T.pin_nth_suffix) + '';
  }
  function render() {
    var on = toggle.checked;
    pos.hidden = !on;
    if (on && Number(rank.value) < 1) rank.value = 1;
    if (!on) rank.value = 0;
    if (label) label.textContent = on ? descr(rank.value) : '';
    if (up) up.disabled = Number(rank.value) <= 1;
  }
  toggle.addEventListener('change', render);
  if (up)   up.addEventListener('click', function () { rank.value = Math.max(1, (Number(rank.value) || 1) - 1); render(); });
  if (down) down.addEventListener('click', function () { rank.value = (Number(rank.value) || 0) + 1; render(); });
  render();
})();

(function () {
  // Keep the Save/Cancel bar (position: sticky; bottom:0) just above two possible
  // obstacles by setting a dynamic bottom offset = the greater of:
  //  1) the height of the keyboard area NOT covered by the layout viewport
  //     (on iOS the visual viewport shifts; on Android the layout viewport shrinks
  //     due to interactive-widget=resizes-content → offset ≈ 0);
  //  2) the height of the playing audio player (fixed, z-index 1000).
  // We stick with sticky (no fixed/top tricks → no bar floating in the middle).
  var bar = document.querySelector('.pe-actions');
  if (!bar) return;
  var vv = window.visualViewport;
  function position() {
    var ap = document.querySelector('.audio-player');
    var playing = document.body.classList.contains('has-audio-player') &&
                  ap && getComputedStyle(ap).display !== 'none';
    var audioOffset = playing ? Math.round(ap.getBoundingClientRect().height) : 0;
    var kbCovered = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    var offset = Math.max(audioOffset, kbCovered);
    bar.style.bottom = offset ? offset + 'px' : '';
  }
  position();
  doc.on(window, 'resize', position);
  if (vv) { doc.on(vv, 'resize', position); doc.on(vv, 'scroll', position); }
  // has-audio-player is toggled via a body class → observe it. De observer
  // overleeft de swap net als de listeners; init() disconnect de vorige.
  try { _barObserver = new MutationObserver(position); _barObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] }); } catch (_) {}
})();
}
