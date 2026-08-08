// De thread onder een post (shaer-tqz): ophalen, normaliseren, niet bewaren.
//
// De vier dingen die hier stil kunnen breken en die een gebruiker allemaal
// anders voelt: een antwoord dat niet doorkomt (te streng), een vreemde die
// bij een ward doorkomt (te los), HTML die ongeschoond doorreist (gevaarlijk),
// en een geblokkeerde die meegeteld wordt in shaer:hidden (een blokkade hoort
// onzichtbaar te zijn, ook als getal).
//
// In-memory SQLite, gestubde fetch op TEST-NET-3. Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'kind', 'Kind', 'u1');

const BRON = 'https://203.0.113.10/notes/post-1';
const TANTE = 'https://203.0.113.20/users/tante';
const VREEMDE = 'https://203.0.113.30/users/vreemde';
const GEBLOKT = 'https://203.0.113.40/users/naar';

// De tante is gevolgd (accepted): zij zit in de kring van de guardians.
db.prepare("INSERT INTO ap_following (slug, actor_uri, status) VALUES ('kind', ?, 'accepted')").run(TANTE);
db.prepare("INSERT INTO ap_blocks (slug, kind, target) VALUES ('kind', 'actor', ?)").run(GEBLOKT);

const actorDoc = (id, naam) => ({ id, type: 'Person', preferredUsername: naam, name: naam, inbox: `${id}/inbox` });
const reply = (n, actor, content, published) => ({
  id: `${BRON}/replies/${n}`, type: 'Note', attributedTo: actor,
  inReplyTo: BRON, content, published,
});

const antwoorden = [
  reply(1, VREEMDE, '<p>Hoi! <script>alert(1)</script></p>', '2026-08-01T10:00:00Z'),
  { ...reply(2, TANTE, '<p>Dag lieverd :hartje:</p>', '2026-08-01T09:00:00Z'),
    // FEP-9098 zoals Mastodon hem stuurt, plus een niet-Emoji-tag en een
    // emoji zonder bruikbaar icoon: alleen de echte hoort erdoor te komen.
    tag: [
      { type: 'Emoji', name: ':hartje:', icon: { type: 'Image', url: 'https://203.0.113.20/emoji/hartje.png' } },
      { type: 'Emoji', name: ':kapot:', icon: {} },
      { type: 'Hashtag', name: '#muziek' },
    ] },
  reply(3, GEBLOKT, '<p>naar bericht</p>', '2026-08-01T11:00:00Z'),
];

globalThis.fetch = async (url) => {
  const u = String(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/activity+json' } });
  if (u === BRON) return json({ id: BRON, type: 'Note', attributedTo: TANTE, content: '<p>de post</p>', replies: `${BRON}/replies` });
  if (u === `${BRON}/replies`) return json({ id: `${BRON}/replies`, type: 'Collection', first: `${BRON}/replies?page=1` });
  if (u === `${BRON}/replies?page=1`) return json({ type: 'CollectionPage', orderedItems: antwoorden });
  if (u === TANTE) return json(actorDoc(TANTE, 'tante'));
  if (u === VREEMDE) return json(actorDoc(VREEMDE, 'vreemde'));
  if (u === GEBLOKT) return json(actorDoc(GEBLOKT, 'naar'));
  return new Response('not found', { status: 404 });
};

test('een gewone lezer krijgt alles behalve de geblokkeerde, oudste eerst, geschoond', async () => {
  const uit = await AP.getThread('kind', BRON, { isWard: false });
  assert.equal(uit.found, true);
  assert.equal(uit.notes.length, 2);
  // Oudste eerst: een gesprek lees je van boven naar beneden.
  assert.equal(uit.notes[0]['shaer:author'].name, 'tante');
  assert.equal(uit.notes[1]['shaer:author'].name, 'vreemde');
  // De sanitizer heeft het script eruit gehaald, de tekst mag blijven.
  assert.ok(!uit.notes[1].content.includes('<script'), 'script weggeschoond');
  assert.ok(uit.notes[1].content.includes('Hoi!'));
  // Een blokkade is onzichtbaar: niet in de lijst en NIET in de telling.
  assert.equal(uit.hidden, 0);
  assert.ok(uit.notes.every((n) => n.attributedTo !== GEBLOKT));
  // FEP-9098: alleen de echte emoji komt door -- niet de hashtag, niet de
  // emoji zonder icoon -- en het icoon-adres is geschoond.
  const tags = uit.notes[0].tag;
  assert.equal(tags.length, 1);
  assert.equal(tags[0].name, ':hartje:');
  assert.equal(tags[0].icon.url, 'https://203.0.113.20/emoji/hartje.png');
  assert.ok(!uit.notes[1].tag, 'een antwoord zonder emoji draagt geen tag-veld');
});

test('een ward ziet alleen de kring van de guardians, de rest wordt geteld', async () => {
  // Eigen cache-sleutel per (slug, uri) zou hier de vorige uitkomst hergeven;
  // een andere slug dwingt een verse opbouw af zonder aan de cache te morrelen.
  db.prepare("INSERT INTO sites (id, slug, title, owner_id) VALUES ('s2', 'pupil', 'Pupil', 'u1')").run();
  db.prepare("INSERT INTO ap_following (slug, actor_uri, status) VALUES ('pupil', ?, 'accepted')").run(TANTE);
  db.prepare("INSERT INTO ap_blocks (slug, kind, target) VALUES ('pupil', 'actor', ?)").run(GEBLOKT);
  const uit = await AP.getThread('pupil', BRON, { isWard: true });
  assert.equal(uit.notes.length, 1);
  assert.equal(uit.notes[0]['shaer:author'].name, 'tante');
  // De vreemde is er, en dat mag gezegd: geteld, niet stil weggelaten.
  assert.equal(uit.hidden, 1);
});

test('een onbereikbare note zegt dat, in plaats van een lege thread te veinzen', async () => {
  const uit = await AP.getThread('kind', 'https://203.0.113.99/weg', { isWard: false });
  assert.equal(uit.found, false);
  assert.equal(uit.notes.length, 0);
});

test('de Mastodon-vorm: first is een lege inline-pagina, de antwoorden staan op next', async () => {
  // Precies wat Mastodon serveert en wat Barts melding (8-8) verklaarde: wie
  // alleen de eerste pagina leest, ziet op elke Mastodon-post een leeg gesprek.
  const MPOST = 'https://203.0.113.50/notes/masto-1';
  const vorige = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/activity+json' } });
    if (u === MPOST) return json({
      id: MPOST, type: 'Note', attributedTo: TANTE, content: '<p>toot</p>',
      replies: {
        id: `${MPOST}/replies`, type: 'Collection',
        first: { type: 'CollectionPage', items: [], next: `${MPOST}/replies?page=true` },
      },
    });
    if (u === `${MPOST}/replies?page=true`) return json({
      type: 'CollectionPage',
      items: [{ id: `${MPOST}/r1`, type: 'Note', attributedTo: TANTE, inReplyTo: MPOST, content: '<p>eerste echte antwoord</p>', published: '2026-08-02T10:00:00Z' }],
    });
    return vorige(url);
  };
  const uit = await AP.getThread('kind', MPOST, { isWard: false });
  globalThis.fetch = vorige;
  assert.equal(uit.notes.length, 1, 'het antwoord op de next-pagina is gevonden');
  assert.ok(uit.notes[0].content.includes('eerste echte antwoord'));
});

test('de tweede lezing komt uit het geheugen, niet van het netwerk', async () => {
  let calls = 0;
  const vorige = globalThis.fetch;
  globalThis.fetch = async (...a) => { calls += 1; return vorige(...a); };
  const uit = await AP.getThread('kind', BRON, { isWard: false });
  assert.equal(uit.notes.length, 2);
  assert.equal(calls, 0, 'alles uit de cache, nul fetches');
  globalThis.fetch = vorige;
});
