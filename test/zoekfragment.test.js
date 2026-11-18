// Het zoekfragment (shaer-y029): de treffer gemarkeerd, en een betaalde post
// zonder de woorden van achter de muur.
//
//   1. cleanSnippet poetste '>' weg (een markdown-citaat) en sloopte daarmee
//      de <mark> die snippet() zette: '<mark kokosnoot</mark voor'. De browser
//      maakte er een kapot element van en het gezochte woord viel weg.
//   2. Een betaalde post toonde 18 woorden rond de treffer, ook achter de muur.
//      Barts keuze: hij mag op de hele tekst gevonden worden, maar toont dan
//      zijn teaser -- die staat al voor iedereen op de betaalpoort.
//
// In-memory SQLite. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const { default: HtmlSanitizerService } = await import('../src/services/HtmlSanitizerService.js');
const searchMod = await import('../src/routes/search.js');
const { cleanSnippet } = searchMod;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'maker', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u2', 'lezer', 'u2@t', 'x', 'user');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'ik', 'Ik', 'u1');

// Zoals posts.js en ap-c2s.js indexeren: toPlainText van de inhoud.
const zet = ({ id, title = '', excerpt = '', content, paid = 0 }) => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, excerpt, content, status, type, paid, published_at)
              VALUES (?, 's1', ?, 'u1', ?, ?, ?, 'published', 'post', ?, '2026-11-01T00:00:00Z')`)
    .run(id, id, title, excerpt, content, paid);
  db.prepare('INSERT INTO posts_fts(content, title, author, post_id) VALUES (?,?,?,?)')
    .run(HtmlSanitizerService.toPlainText(content), title, 'maker', id);
};
zet({ id: 'open', title: 'Open', content: '<p>Een kokosnoot voor iedereen, en &lt;b&gt;vet&lt;/b&gt; als tekst.</p>' });
zet({ id: 'betaald', title: 'Voor supporters', paid: 1,
  content: '<p>Gratis begin van het verhaal.</p><p>Daarna de geheime ananas achter de muur.</p>' });

let wie = null;
const express = (await import('express')).default;
const app = express();
app.use((req, res, next) => {
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  req.session = wie ? { user: wie } : {};
  next();
});
app.use('/search', searchMod.default);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
server.unref();
after(() => server.close());

// Alleen de fragmenten: de pagina herhaalt de zoekterm ook elders.
const fragmenten = async (q, als = null) => {
  wie = als;
  const r = await fetch(`http://127.0.0.1:${server.address().port}/search?q=${encodeURIComponent(q)}`);
  assert.equal(r.status, 200);
  const html = await r.text();
  return [...html.matchAll(/<span class="sr-item-snippet">([\s\S]*?)<\/span>/g)].map((m) => m[1]);
};

test('cleanSnippet: de markering overleeft het opschonen', () => {
  assert.equal(cleanSnippet('een \u0002kokosnoot\u0003 voor', ''), 'een <mark>kokosnoot</mark> voor');
  assert.equal(cleanSnippet('> een \u0002citaat\u0003', ''), 'een <mark>citaat</mark>', 'het markdown-citaat gaat er nog steeds af');
});

test('cleanSnippet: ruwe < en > blijven tekst', () => {
  // De index bewaart ontsnapte tekst; staat er toch iets ruws in (een oude
  // rij), dan mag dat geen opmaak worden in een fragment dat ongefilterd de
  // pagina in gaat.
  const s = cleanSnippet('<img src=x onerror=alert(1)> \u0002woord\u0003', '');
  assert.ok(!s.includes('<img'), s);
  assert.ok(s.includes('&lt;img') && s.includes('<mark>woord</mark>'), s);
});

test('cleanSnippet: zonder fragment het excerpt, ontsnapt', () => {
  assert.equal(cleanSnippet('… \u0002\u0003 …', 'a <b> & c'), 'a &lt;b&gt; &amp; c');
});

test('de treffer staat gemarkeerd in het fragment', async () => {
  const [f] = await fragmenten('kokosnoot');
  assert.ok(f, 'een treffer');
  assert.match(f, /<mark>kokosnoot<\/mark>/);
  assert.ok(f.includes('&lt;b&gt;vet'), 'ontsnapte tekst blijft ontsnapt');
});

test('een betaalde post: gevonden op de hele tekst, maar met zijn teaser', async () => {
  const [f] = await fragmenten('ananas');
  assert.ok(f !== undefined, 'hij wordt gevonden');
  assert.ok(!/ananas|muur/.test(f), `niets van achter de muur: ${f}`);
  assert.match(f, /Gratis begin van het verhaal/);
  const [lezer] = await fragmenten('ananas', { id: 'u2', role: 'user', username: 'lezer' });
  assert.ok(!/ananas/.test(lezer), 'ook ingelogd is niet ontgrendeld');
});

test('de maker ziet zijn eigen betaalde tekst gewoon', async () => {
  const [f] = await fragmenten('ananas', { id: 'u1', role: 'god', username: 'maker' });
  assert.match(f, /<mark>ananas<\/mark>/);
});
