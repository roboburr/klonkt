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

    // Toolbar commands (execCommand is deprecated-but-universal; same approach
    // as the post editor).
    bar.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-cmd]');
      if (!btn) return;
      e.preventDefault();
      ed.focus();
      var cmd = btn.getAttribute('data-cmd');
      if (cmd === 'bold') document.execCommand('bold');
      else if (cmd === 'italic') document.execCommand('italic');
      else if (cmd === 'list') document.execCommand('insertUnorderedList');
      else if (cmd === 'quote') document.execCommand('formatBlock', false, 'blockquote');
      else if (cmd === 'link') {
        var url = window.prompt(form.getAttribute('data-link-prompt') || 'URL');
        if (url && /^https?:\/\//i.test(url.trim())) document.execCommand('createLink', false, url.trim());
      }
    });

    // Paste as plain text (rich paste becomes messy HTML; formatting is what
    // the toolbar is for). Media paste/drop lands in the media phase.
    ed.addEventListener('paste', function (e) {
      var txt = (e.clipboardData || window.clipboardData).getData('text/plain');
      if (!txt) return;
      e.preventDefault();
      document.execCommand('insertText', false, txt);
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

    // Serialize on submit; block truly empty replies.
    form.addEventListener('submit', function (e) {
      var html = ed.innerHTML.trim();
      var plain = (ed.innerText || '').replace(/ /g, ' ').trim();
      if (!plain) { e.preventDefault(); ed.focus(); return; }
      hidden.value = html;
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
