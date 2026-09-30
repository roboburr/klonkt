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
let opties = [];
AP.resolveRemoteNote = async (uri, opts) => {
  gevraagd.push(['note', uri]);
  opties.push(opts || {});
  if (!uri.includes('/notes/')) return null;
  return {
    object_uri: uri, url: uri,
    actor_uri: 'https://elders.test/u/oma', actor_url: 'https://elders.test/@oma',
    actor_handle: '@oma@elders.test', actor_name: 'Oma', actor_icon: '',
    content: '<p>Een bericht van ver weg</p>', images: [], media: [], poll: null,
    preview: 'Een bericht van ver weg', threadInboxes: [], localPostId: '',
    sensitive: uri.includes('/cw'), cw: uri.includes('/cw') ? 'Spinnen' : '',
  };
};
let actorOpties = [];
AP.resolveRemoteActor = async (uri, opts) => {
  gevraagd.push(['actor', uri]);
  actorOpties.push(opts || {});
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
  assert.ok(html.includes('.rp-card'), 'de opmaak van de kaart ontbreekt');
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

// ── De live-preview onder de zoekbalk ───────────────────────────────────────
//
// Plak je een link, dan laadt de uitklaplijst de post zelf. Deze route wordt bij
// elke toetsaanslag geraakt, en dat maakt de rechtencheck hier zwaarder dan op
// de pagina: zonder hem is dit een haalservice waarmee iedereen deze server op
// adressen naar keuze laat afsturen.

const preview = async (q) => {
  gevraagd = []; opties = [];
  const r = await fetch(`http://127.0.0.1:${poort}/search/remote?q=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) });
  return { status: r.status, html: await r.text(), cache: r.headers.get('cache-control') };
};

test('de preview laadt de post zelf, ondertekend als de site', async () => {
  const { status, html, cache } = await preview('https://elders.test/notes/1');
  assert.equal(status, 200);
  assert.ok(html.includes('Een bericht van ver weg'), 'de inhoud hoort in de preview te staan');
  assert.ok(html.includes('@oma@elders.test'));
  assert.equal(opties[0].asSlug, 'robo', 'een post voor volgers weigert een anonieme GET');
  // Wat iemand ziet hangt van zijn rechten en reacties af.
  assert.match(cache || '', /no-store/);
});

test('in de preview kun je waarderen en boosten, antwoorden gaat naar de volle pagina', async () => {
  const { html } = await preview('https://elders.test/notes/1');
  for (const actie of ['/authorize_interaction/like', '/authorize_interaction/boost']) {
    assert.ok(html.includes(`action="${actie}"`), `${actie} hoort in de preview te staan`);
  }
  // Een editor in een uitklaplijst is op een telefoon geen plek om te
  // schrijven: de antwoordknop wijst naar de volle pagina, met het venster open.
  assert.ok(!html.includes('action="/authorize_interaction"'), 'geen antwoordvenster in de preview');
  assert.ok(!html.includes('action="/authorize_interaction/report"'), 'melden gebeurt op de volle pagina');
  assert.ok(html.includes('/authorize_interaction?uri=https%3A%2F%2Felders.test%2Fnotes%2F1&amp;reply=1'),
    'de antwoordknop moet naar de volle pagina met het venster al open');
});

test('een profiel in de preview geeft de volgknop', async () => {
  const { status, html } = await preview('https://elders.test/u/oma');
  assert.equal(status, 200);
  assert.ok(html.includes('action="/authorize_interaction/follow"'));
});

test('een bezoeker laat via de preview niets ophalen', async () => {
  ingelogd = false;
  try {
    const { status, html } = await preview('https://elders.test/notes/1');
    // 204 en geen 403: voor een bezoeker is een geplakte link gewoon een
    // zoekterm, en de zoekbalk valt dan terug op de gewone suggesties.
    assert.equal(status, 204);
    assert.deepEqual(gevraagd, [], 'zonder rechten hoort er geen enkel verzoek uit te gaan');
    assert.equal(html, '');
  } finally {
    ingelogd = true;
  }
});

test('een zoekterm in de preview haalt niets op', async () => {
  const { status } = await preview('soundfabrics.nl');
  assert.equal(status, 204);
  assert.deepEqual(gevraagd, []);
});

test('een inhoudswaarschuwing blijft dicht tot je ervoor kiest', async () => {
  // De oude render toonde alles open, ook wat de schrijver achter een
  // waarschuwing had gezet.
  const { html } = await preview('https://elders.test/notes/cw');
  const cw = html.indexOf('<details class="rp-cw">');
  assert.ok(cw >= 0, 'de post hoort achter een waarschuwing te staan');
  assert.ok(html.indexOf('Spinnen', cw) > cw, 'met de tekst van de waarschuwing erop');
  assert.ok(html.indexOf('Een bericht van ver weg') > cw, 'en de inhoud erachter, niet ervoor');
});

test('de interactiepagina opent het antwoordvenster op verzoek, en haalt ondertekend op', async () => {
  const pagina = async (extra) => {
    opties = [];
    const r = await fetch(
      `http://127.0.0.1:${poort2}/authorize_interaction?uri=${encodeURIComponent('https://elders.test/notes/1')}${extra}`,
      { signal: AbortSignal.timeout(10000) },
    );
    return r.text();
  };
  const dicht = await pagina('');
  assert.match(dicht, /<section class="rp-reply" id="rp-reply" hidden>/, 'zonder verzoek is het venster dicht');
  assert.equal(opties[0].asSlug, 'robo', 'ook hier ondertekend, anders "niet gevonden" voor een volgerspost');
  const open = await pagina('&reply=1');
  assert.match(open, /<section class="rp-reply" id="rp-reply">/, 'met ?reply=1 staat het open, ook zonder JS');
  assert.ok(open.includes('action="/authorize_interaction"'), 'en het venster heeft zijn formulier');
});

// ── Een profiel op een instance met authorized fetch ────────────────────────
//
// mastodon.social geeft een onbetekende GET van een profiel een 401; arvr.social
// niet. Het profiel werd onbetekend opgehaald, dus het ene Mastodon toonde een
// profiel en het andere "niet gevonden". De post-kant was al ondertekend, de
// profiel-kant niet (gemeten op dev, 30-9: onbetekend niets, als dev gevonden).
//
// En de regel eronder: ondertekenen is deze site die voor het verzoek instaat,
// en dat mag alleen namens een INGELOGDE beheerder. Een bezoeker laat niets
// ophalen, ondertekend of niet.

test('een profiel wordt ondertekend opgehaald, op de zoekpagina en in de preview', async () => {
  actorOpties = [];
  await zoek('https://elders.test/u/oma');
  assert.equal(actorOpties[0] && actorOpties[0].asSlug, 'robo', 'de zoekpagina haalt het profiel als de site op');
  actorOpties = [];
  await preview('https://elders.test/u/oma');
  assert.equal(actorOpties[0] && actorOpties[0].asSlug, 'robo', 'de preview ook');
});

test('ook de interactiepagina haalt een profiel ondertekend op', async () => {
  actorOpties = [];
  await fetch(`http://127.0.0.1:${poort2}/authorize_interaction?uri=${encodeURIComponent('https://elders.test/u/oma')}`,
    { signal: AbortSignal.timeout(10000) });
  assert.equal(actorOpties[0] && actorOpties[0].asSlug, 'robo');
});

test('niet ingelogd gaat er geen enkel verzoek uit, dus ook geen ondertekend', async () => {
  ingelogd = false;
  try {
    actorOpties = [];
    await zoek('https://elders.test/u/oma');
    await preview('https://elders.test/u/oma');
    assert.deepEqual(gevraagd, [], 'geen post- en geen profielopvraging');
    assert.deepEqual(actorOpties, [], 'en dus niets dat de sleutel van de site gebruikt');
  } finally {
    ingelogd = true;
  }
});

