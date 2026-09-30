// Een geplakt adres in de zoekbalk is geen zoekterm (shaer-utpi).
//
// Wat hier bewaakt wordt, en waarom het elk een eigen zaak is:
//
//   1. HERKENNING. "soundfabrics.nl" is een zoekterm en https://... is een
//      adres. Het schema is het verschil; zonder die regel wordt elke
//      zoekopdracht met een punt erin een uitgaand netwerkverzoek.
//   2. WIE HET MAG LATEN OPHALEN. Ophalen is een verzoek dat deze server
//      namens de bezoeker doet. Voor een willekeurige bezoeker zou de zoekbalk
//      daarmee een haalservice zijn waarmee je andermans server laat aankloppen
//      op adressen naar keuze. Dezelfde grens als /authorize_interaction.
//   3. DAT DE KNOPPEN ER ECHT STAAN. De render is een gedeelde partial; valt
//      die uit de pagina, dan ziet het er nog steeds uit als een gevonden post
//      en kan er alleen niets meer mee.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }

const AP = (await import('../src/services/ActivityPubService.js')).default;
const searchMod = await import('../src/routes/search.js');
const router = searchMod.default;
const { lookupUri } = searchMod;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'baas', 'b@t.nl', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)')
  .run('s1', 'robo', 'Soundfabrics', 'u1');
const site = () => db.prepare('SELECT * FROM sites WHERE id = ?').get('s1');

// De echte resolvers doen netwerk. Hier staat wat ze zouden vinden, plus een
// teller: "is er überhaupt opgehaald" is de helft van wat deze toets bewaakt.
let gevraagd = [];
AP.resolveRemoteNote = async (uri) => {
  gevraagd.push(['note', uri]);
  if (!uri.includes('/notes/')) return null;
  return {
    object_uri: uri, url: uri,
    actor_uri: 'https://elders.test/u/oma', actor_url: 'https://elders.test/@oma',
    actor_handle: '@oma@elders.test', actor_name: 'Oma', actor_icon: '',
    content: '<p>Een bericht van ver weg</p>', images: [], media: [], poll: null,
    preview: 'Een bericht van ver weg', threadInboxes: [], localPostId: '', sensitive: false, cw: '',
  };
};
AP.resolveRemoteActor = async (uri) => {
  gevraagd.push(['actor', uri]);
  if (!uri.includes('/u/')) return null;
  return {
    actor_uri: uri, actor_name: 'Oma', actor_handle: '@oma@elders.test',
    actor_url: uri, actor_icon: 'https://elders.test/avatar.png', inbox: uri + '/inbox',
  };
};

const express = (await import('express')).default;
let ingelogd = true;
const app = express();
app.use((req, res, next) => {
  res.locals.site = site();
  res.locals.siteUrlBase = '';
  req.session = ingelogd ? { user: { id: 'u1', role: 'god', username: 'baas' } } : {};
  next();
});
app.use('/search', router);
const server = app.listen(0);
server.unref();
const poort = server.address().port;
test.after(() => server.close());

const zoek = async (q) => {
  gevraagd = [];
  const r = await fetch(`http://127.0.0.1:${poort}/search?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) });
  return { status: r.status, html: await r.text() };
};

test('een adres wordt herkend, een zoekterm niet', () => {
  assert.equal(lookupUri('https://elders.test/notes/1'), 'https://elders.test/notes/1');
  assert.equal(lookupUri('  https://elders.test/notes/1  '), 'https://elders.test/notes/1');
  // De fragmentverwijzing hoort bij de browser, niet bij het object.
  assert.equal(lookupUri('https://elders.test/notes/1#comment-2'), 'https://elders.test/notes/1');
  // Geen schema is geen adres: anders wordt zoeken naar een naam een verzoek.
  assert.equal(lookupUri('soundfabrics.nl'), null);
  assert.equal(lookupUri('www.soundfabrics.nl/muziek'), null);
  assert.equal(lookupUri('soundfabrics'), null);
  // Twee woorden waarvan er een een adres is, is een zoekopdracht.
  assert.equal(lookupUri('https://elders.test/notes/1 oma'), null);
  // Andere schema's halen we niet op.
  assert.equal(lookupUri('javascript:alert(1)'), null);
  assert.equal(lookupUri('file:///etc/passwd'), null);
  // Een naam zonder punt is geen adres op het open net.
  assert.equal(lookupUri('http://localhost:3000/notes/1'), null);
});

test('een gewone zoekopdracht haalt niets op', async () => {
  const { status, html } = await zoek('muziek');
  assert.equal(status, 200);
  assert.deepEqual(gevraagd, [], 'een zoekterm hoort geen netwerkverzoek te worden');
  assert.ok(!html.includes('search-remote'), 'en er hoort geen fediverse-blok te staan');
});

test('een post van een andere server komt met zijn knoppen binnen', async () => {
  const { html } = await zoek('https://elders.test/notes/1');
  assert.deepEqual(gevraagd, [['note', 'https://elders.test/notes/1']]);
  assert.ok(html.includes('Een bericht van ver weg'), 'de inhoud hoort er te staan');
  assert.ok(html.includes('@oma@elders.test'), 'en van wie het is');
  // De functies van authorize_interaction, op de zoekpagina.
  for (const actie of ['/authorize_interaction/like', '/authorize_interaction/boost', '/authorize_interaction/report']) {
    assert.ok(html.includes(`action="${actie}"`), `${actie} ontbreekt`);
  }
  assert.ok(html.includes('action="/authorize_interaction"'), 'het antwoordvenster ontbreekt');
});

test('een profiel levert de volgknop', async () => {
  const { html } = await zoek('https://elders.test/u/oma');
  assert.deepEqual(gevraagd.map((g) => g[0]), ['note', 'actor'], 'eerst post, dan profiel');
  assert.ok(html.includes('action="/authorize_interaction/follow"'), 'de volgknop ontbreekt');
  assert.ok(html.includes('https://elders.test/u/oma'), 'het profiel hoort in het formulier te staan');
});

test('een adres dat niets oplevert laat de rest van de zoekpagina staan', async () => {
  const { status, html } = await zoek('https://elders.test/iets-anders');
  assert.equal(status, 200);
  assert.equal(gevraagd.length, 2, 'beide vormen zijn geprobeerd');
  assert.ok(html.includes('search-remote'), 'het blok staat er, met de melding erin');
  assert.ok(html.includes('search-page-form'), 'en de zoekpagina zelf is niet weggevallen');
});

test('een bezoeker laat deze server niets ophalen', async () => {
  ingelogd = false;
  try {
    const { status, html } = await zoek('https://elders.test/notes/1');
    assert.equal(status, 200);
    assert.deepEqual(gevraagd, [], 'zonder rechten hoort er geen enkel verzoek uit te gaan');
    assert.ok(!html.includes('/authorize_interaction/like'), 'en er staan geen knoppen');
  } finally {
    ingelogd = true;
  }
});

// ── Dezelfde render, de andere ingang ───────────────────────────────────────
//
// De zoekpagina en /authorize_interaction delen sinds deze ronde één partial.
// Die pagina had zelf geen enkele toets, dus een verhuizing van 200 regels eruit
// zou stil kunnen mislukken: de suite bleef groen en het scherm was leeg. Deze
// toets is de bodem daaronder.
const postsRouter = (await import('../src/routes/posts.js')).default;
const app2 = express();
app2.use((req, res, next) => {
  res.locals.site = site();
  res.locals.siteUrlBase = '';
  req.session = { user: { id: 'u1', role: 'god', username: 'baas' } };
  next();
});
app2.use('/', postsRouter);
const server2 = app2.listen(0);
server2.unref();
const poort2 = server2.address().port;
test.after(() => server2.close());

test('de interactiepagina toont hetzelfde als de zoekpagina', async () => {
  const r = await fetch(
    `http://127.0.0.1:${poort2}/authorize_interaction?uri=${encodeURIComponent('https://elders.test/notes/1')}`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('Een bericht van ver weg'), 'de inhoud hoort er te staan');
  assert.ok(html.includes('@oma@elders.test'), 'en van wie het is');
  for (const actie of ['/authorize_interaction/like', '/authorize_interaction/boost', '/authorize_interaction/report']) {
    assert.ok(html.includes(`action="${actie}"`), `${actie} ontbreekt op de interactiepagina`);
  }
  // En de opmaak reist mee: die staat sinds deze ronde in een eigen partial,
  // en een render zonder opmaak ziet er kapot uit zonder dat er iets faalt.
  assert.ok(html.includes('.auth-interact-preview'), 'de opmaak van het blok ontbreekt');
});

test('een profiel op de interactiepagina levert dezelfde volgknop', async () => {
  const r = await fetch(
    `http://127.0.0.1:${poort2}/authorize_interaction?uri=${encodeURIComponent('https://elders.test/u/oma')}`,
    { signal: AbortSignal.timeout(10000) },
  );
  const html = await r.text();
  assert.ok(html.includes('action="/authorize_interaction/follow"'), 'de volgknop ontbreekt');
  assert.ok(html.includes('@oma@elders.test'));
});
