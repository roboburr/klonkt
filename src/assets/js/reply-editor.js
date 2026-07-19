// Rich reply editor — upgrades every form[data-re] (partials/reply-editor.ejs)
// from a plain textarea to a contenteditable with a small toolbar and, on
// narrow screens (≤700px), a full-screen compose overlay (the right pattern on
// mobile). Progressive enhancement: without this file the textarea submits as
// before. On submit: `content` = editor HTML (server sanitizes), `text` =
// plain-text fallback.
(function () {
  'use strict';
  if (window.__replyEditorInit) return;
  window.__replyEditorInit = true;

  var MOBILE = '(max-width: 700px)';

  function init(form) {
    if (form.__re) return;
    form.__re = true;

    var ta = form.querySelector('textarea[name="text"]');
    var ed = form.querySelector('.re-editor');
    var bar = form.querySelector('.re-toolbar');
    var head = form.querySelector('.re-head');
    var foot = form.querySelector('.re-foot');
    var lang = form.querySelector('.re-lang');
    var hidden = form.querySelector('input[name="content"]');
    if (!ta || !ed || !hidden) return;

    // Upgrade: swap the textarea for the editor.
    ta.hidden = true;
    ta.required = false;
    ed.hidden = false;
    bar.hidden = false;
    if (lang) lang.hidden = false;

    // ── Media attachments: picker (📎), drag/drop and paste ──────────────
    var attWrap = form.querySelector('.re-attachments');
    var attField = form.querySelector('input[name="attachments"]');
    var fileInput = form.querySelector('.re-file');
    var attachments = [];

    function syncAtt() {
      attField.value = attachments.length ? JSON.stringify(attachments) : '';
      attWrap.hidden = attachments.length === 0;
    }
    function addChip(a) {
      var chip = document.createElement('span');
      chip.className = 're-att';
      if (a.mediaType.indexOf('image/') === 0) {
        var img = document.createElement('img');
        img.src = a.url; img.alt = a.name || '';
        chip.appendChild(img);
      } else {
        chip.appendChild(document.createTextNode((a.mediaType.indexOf('audio/') === 0 ? '🎵 ' : '🎬 ') + (a.name || a.mediaType)));
      }
      var del = document.createElement('button');
      del.type = 'button'; del.className = 're-att-del'; del.textContent = '×';
      del.addEventListener('click', function () {
        attachments = attachments.filter(function (x) { return x !== a; });
        chip.remove(); syncAtt();
      });
      chip.appendChild(del);
      attWrap.appendChild(chip);
    }
    function uploadFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        if (!/^(image|audio|video)\//.test(file.type) || attachments.length >= 4) return;
        var chip = document.createElement('span');
        chip.className = 're-att re-att-busy';
        chip.textContent = '⏳ ' + file.name;
        attWrap.hidden = false;
        attWrap.appendChild(chip);
        var fd = new FormData();
        fd.append('media', file);
        fetch(form.getAttribute('data-upload'), { method: 'POST', body: fd })
          .then(function (r) { return r.json().then(function (j) { return r.ok ? j : Promise.reject(j); }); })
          .then(function (j) {
            chip.remove();
            var a = { url: j.url, mediaType: j.mediaType, name: j.name || file.name };
            attachments.push(a); addChip(a); syncAtt();
          })
          .catch(function (err) {
            chip.className = 're-att re-att-err';
            chip.textContent = (form.getAttribute('data-upload-err') || 'Upload failed') + (err && err.error ? ': ' + err.error : '');
            setTimeout(function () { chip.remove(); syncAtt(); }, 5000);
          });
      });
    }

    // Toolbar commands (execCommand is deprecated-but-universal; same approach
    // as the post editor).
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      e.preventDefault();
      var cmd = btn.getAttribute('data-cmd');
      if (cmd === 'attach') { fileInput.click(); return; }   // no editor focus: keeps the picker usable on mobile
      ed.focus();
      if (cmd === 'bold') document.execCommand('bold');
      else if (cmd === 'italic') document.execCommand('italic');
      else if (cmd === 'list') document.execCommand('insertUnorderedList');
      else if (cmd === 'quote') document.execCommand('formatBlock', false, 'blockquote');
      else if (cmd === 'link') {
        var url = window.prompt(form.getAttribute('data-link-prompt') || 'URL');
        if (url && /^https?:\/\//i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      }
    });
    fileInput.addEventListener('change', function () {
      uploadFiles(fileInput.files);
      fileInput.value = '';
    });

    // Paste: files become attachments; text pastes as plain text (rich paste
    // becomes messy HTML; formatting is what the toolbar is for).
    ed.addEventListener('paste', function (e) {
      var cd = e.clipboardData || window.clipboardData;
      if (cd.files && cd.files.length) {
        e.preventDefault();
        uploadFiles(cd.files);
        return;
      }
      var txt = cd.getData('text/plain');
      if (!txt) return;
      e.preventDefault();
      document.execCommand('insertText', false, txt);
    });

    // Drag/drop media onto the editor.
    ed.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) {
        e.preventDefault();
        ed.classList.add('re-drop');
      }
    });
    ed.addEventListener('dragleave', function () { ed.classList.remove('re-drop'); });
    ed.addEventListener('drop', function (e) {
      ed.classList.remove('re-drop');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        uploadFiles(e.dataTransfer.files);
      }
    });

    // Full-screen compose on mobile: enter on focus, leave via ×.
    function setFull(on) {
      form.classList.toggle('re-full', on);
      head.hidden = !on;
      document.documentElement.classList.toggle('re-lock', on);
      if (on) ed.focus();
    }
    ed.addEventListener('focus', function () {
      if (window.matchMedia(MOBILE).matches && !form.classList.contains('re-full')) setFull(true);
    });
    var cancel = form.querySelector('.re-cancel');
    if (cancel) cancel.addEventListener('click', function () { setFull(false); });

    // Serialize on submit; block truly empty replies (media-only is fine).
    form.addEventListener('submit', function (e) {
      var html = ed.innerHTML.trim();
      var plain = (ed.innerText || '').replace(/ /g, ' ').trim();
      if (!plain && !attachments.length) { e.preventDefault(); ed.focus(); return; }
      hidden.value = plain ? html : '';
      ta.value = plain;
      document.documentElement.classList.remove('re-lock');
    });

    // Open <details> parents (fedi-node) keep working: nothing special needed.
    void foot;
  }

  function initAll() {
    document.querySelectorAll('form[data-re]').forEach(init);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
