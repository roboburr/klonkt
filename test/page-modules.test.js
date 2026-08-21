// Route -> module-dekking (shaer-5s1, de beet van 7 augustus).
//
// Sinds shaer-bqr leeft het gedrag van een pagina in assets/js/mod/ en
// declareert de ROUTE welke modules laden (pageJs). Dat is een naad die stil
// scheurt: vergeet een route zijn pageJs, dan rendert de pagina foutloos maar
// doet hij niets -- en bij de posteditor WIST een opslag dan de post, want
// alleen de module vult het verborgen contentveld. Zo verloor de editpagina
// op 7 augustus zijn editor: de nieuw-route kreeg pageJs bij de refactor, de
// edit-route niet, en geen test die het zag.
//
// Dit is bewust een test op de BRONTEKST, niet op gedrag: het gedrag zit in
// de browser (module + DOM) en buiten bereik van node:test. Een greep op de
// routes is grof, maar hij scheurt luid op precies de fout die ons beet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const posts = readFileSync(new URL('../src/routes/posts.js', import.meta.url), 'utf8');
const download = readFileSync(new URL('../src/routes/download.js', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../src/views/pages/post-edit.ejs', import.meta.url), 'utf8');

// Elke renderPage van een template, met zijn optieblok (tot de sluithaak).
function renderCalls(src, tpl) {
  const out = [];
  const re = new RegExp(String.raw`renderPage\(req, res, '${tpl}'\s*,\s*\{`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

test('elke render van de posteditor declareert zijn modules', () => {
  const calls = renderCalls(posts, 'pages/post-edit');
  assert.equal(calls.length, 2, 'nieuw + edit; een derde render moet hier ook langs');
  for (const c of calls) {
    assert.match(c, /pageJs:\s*'post-edit playlist-editor'/,
      'een posteditor zonder modules wist bij opslaan de post');
  }
});

test('het verborgen contentveld draagt de bestaande inhoud', () => {
  // Zonder module is opslaan dan een no-op in plaats van een wisser --
  // dit is de vangrail ONDER de test hierboven.
  assert.match(editor, /id="content-hidden" value="<%= post\.content \|\| '' %>"/);
});

test('de download-autostart hoort alleen bij de ready-staat', () => {
  const calls = renderCalls(download, 'pages/download');
  assert.equal(calls.length, 3, 'formulier, formulier-met-fout, ready');
  for (const c of calls) {
    if (/dlState: 'ready'/.test(c)) {
      assert.match(c, /pageJs: 'download'/, 'ready zonder module = geen auto-start');
    } else {
      assert.doesNotMatch(c, /pageJs/,
        'de module op de formulier-staat omzeilt de e-mailvraag');
    }
  }
});
