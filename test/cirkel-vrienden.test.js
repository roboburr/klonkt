// We zetten onze vrienden niet te kijk (shaer-7jkp).
//
// Wie we volgen, stuurt ons ook zijn vriendenposts. Die kwamen in ap_timeline
// zonder zichtbaarheid, en de openbare /cirkel toonde ze met hun hele tekst.
// Twee verwante plekken: onze eigen vriendenantwoorden stonden in het openbare
// draadje onder een post, en een archief nam de zichtbaarheid van antwoorden
// niet mee (alles kwam terug als openbaar).
//
// De regels nu:
//   - /cirkel: 'public', en 'unlisted' alleen als wij hem boostten;
//   - een oude rij zonder zichtbaarheid: eraf, tot een eenmalige herkeuring
//     (ondertekend ophalen, de adressering beslist) hem een waarde geeft;
//   - het draadje: geen vriendenantwoord of DM, van ons of van een ander;
//   - het archief: de zichtbaarheid gaat mee; een oud archief zonder = verborgen.
// Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
// Het actor-document van de vriend mag door de SSRF-poort; fetch is gestubd.
process.env.AP_ALLOW_HOSTS = 'vriend.example';
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const AP = (await import('../src/services/ActivityPubService.js')).default;
const { herkeurCirkel } = await import('../src/services/ap-cirkel.js');
const AX = await import('../src/services/ArchiveExportService.js');
const AI = await import('../src/services/ArchiveImportService.js');

const VRIEND = 'https://vriend.example/users/v';
const ANDER = 'https://ander.example/users/a';

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'ik', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary, is_public) VALUES (?,?,?,?,1,1)').run('s1', 'ik', 'Ik', 'u1');
// We volgen de vriend, en hebben hem uitgelicht: zijn posts horen op de Cirkel.
db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, name, inbox, status, auto_boost)
            VALUES ('ik', ?, '@v@vriend.example', 'Vriend', ?, 'accepted', 1)`).run(VRIEND, `${VRIEND}/inbox`);

const echt = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (String(url).startsWith(VRIEND)) {
    return new Response(JSON.stringify({ id: VRIEND, type: 'Person', preferredUsername: 'v', name: 'Vriend', inbox: `${VRIEND}/inbox` }),
      { status: 200, headers: { 'Content-Type': 'application/activity+json' } });
  }
  return new Response('', { status: 404 });
};
after(() => { globalThis.fetch = echt; });

const binnen = (note) => AP.handleInbox(
  { body: { type: 'Create', actor: VRIEND, to: note.to, cc: note.cc, object: { type: 'Note', attributedTo: VRIEND, published: '2026-11-18T10:00:00Z', ...note } },
    ip: '1.2.3.4', protocol: 'https', get: () => 'klonkt.test', headers: {} },
  'ik', { id: VRIEND });

const express = (await import('express')).default;
const app = express();
app.use((req, res, next) => {
  res.locals.site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  res.locals.siteUrlBase = '';
  next();
});
app.use((await import('../src/routes/circle.js')).default);
app.use((req, res) => res.status(404).end());
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
server.unref();
after(() => server.close());
const cirkel = async () => {
  const r = await echt(`http://127.0.0.1:${server.address().port}/cirkel`);   // de echte: fetch is gestubd
  return { status: r.status, html: await r.text() };
};
const zicht = (id) => (db.prepare('SELECT visibility FROM ap_timeline WHERE id = ?').get(id) || {}).visibility;

test('de inbox bewaart de zichtbaarheid van wat binnenkomt', async () => {
  await binnen({ id: `${VRIEND}/n/open`, content: '<p>Openbare appel</p>', to: [PUBLIC], cc: [`${VRIEND}/followers`] });
  await binnen({ id: `${VRIEND}/n/vrienden`, content: '<p>Geheime peer voor vrienden</p>', to: [`${VRIEND}/followers`] });
  await binnen({ id: `${VRIEND}/n/stil`, content: '<p>Stille pruim</p>', to: [`${VRIEND}/followers`], cc: [PUBLIC] });
  assert.equal(zicht(`${VRIEND}/n/open`), 'public');
  assert.equal(zicht(`${VRIEND}/n/vrienden`), 'followers');
  assert.equal(zicht(`${VRIEND}/n/stil`), 'unlisted');
});

test('/cirkel: het openbare wel, de vriendenpost en de stille niet', async () => {
  const { status, html } = await cirkel();
  assert.equal(status, 200);
  assert.ok(html.includes('Openbare appel'));
  assert.ok(!html.includes('Geheime peer'), 'een vriendenpost van een ander staat niet op onze openbare pagina');
  assert.ok(!html.includes('Stille pruim'), 'een uitgelicht account dat niet in openbare tijdlijnen wilde, zetten we er niet zelf in');
});

test('een stille post die wij boostten, staat er wel', async () => {
  // De echte weg van een boost: setReaction legt hem vast en bewaart de note.
  AP.setReaction('ik', `${ANDER}/n/geboost`, 'boost', true, { note: {
    object_uri: `${ANDER}/n/geboost`, actor_uri: ANDER, actor_name: 'Ander', content: '<p>Bewust geboost</p>',
    url: `${ANDER}/n/geboost`, visibility: 'unlisted',
  } });
  assert.equal(zicht(`${ANDER}/n/geboost`), 'unlisted', 'de boost bewaart de zichtbaarheid');
  assert.ok((await cirkel()).html.includes('Bewust geboost'));
});

test('een oude rij zonder zichtbaarheid staat er niet op', async () => {
  db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, author_name, content, url, published)
              VALUES (?, 'ik', ?, 'Vriend', '<p>Oude onbekende</p>', ?, '2026-01-01T00:00:00Z')`)
    .run(`${VRIEND}/n/oud`, VRIEND, `${VRIEND}/n/oud`);
  assert.ok(!(await cirkel()).html.includes('Oude onbekende'));
});

test('de herkeuring: de adressering beslist, een weigering verbergt, een storing wacht', async () => {
  const oud = (id) => db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES (?, 'ik', ?, '<p>x</p>')`).run(id, VRIEND);
  for (const n of ['h-open', 'h-vrienden', 'h-weg', 'h-storing']) oud(`${VRIEND}/n/${n}`);
  // Niet van een uitgelicht account en niet geboost: geen kandidaat, niet ophalen.
  db.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, content) VALUES (?, 'ik', ?, '<p>x</p>')`).run(`${ANDER}/n/los`, ANDER);
  const opgehaald = [];
  const r = await herkeurCirkel('ik', {
    zicht: AP.noteVisibility,
    get: async (slug, url, onStatus) => {
      opgehaald.push(url);
      if (url.endsWith('/h-open')) { onStatus(200); return { id: url, type: 'Note', to: [PUBLIC] }; }
      // Als volger krijgen we de vriendenpost wel -- met zijn adressering.
      if (url.endsWith('/h-vrienden')) { onStatus(200); return { type: 'Create', object: { id: url, type: 'Note', to: [`${VRIEND}/followers`] } }; }
      if (url.endsWith('/h-weg')) { onStatus(410); return null; }
      return null;                                   // storing: geen status
    },
  });
  assert.equal(zicht(`${VRIEND}/n/h-open`), 'public');
  assert.equal(zicht(`${VRIEND}/n/h-vrienden`), 'followers');
  assert.equal(zicht(`${VRIEND}/n/h-weg`), 'onbekend');
  assert.equal(zicht(`${VRIEND}/n/h-storing`), null, 'een storing laat hem voor de volgende keer');
  assert.ok(!opgehaald.includes(`${ANDER}/n/los`), 'alleen kandidaten voor de Cirkel');
  assert.ok(r.bekeken >= 3);
});

test('het draadje onder een post: geen vriendenantwoord of DM, van ons of van een ander', () => {
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, published_at)
              VALUES ('p1','s1','p1','u1','Post','<p>x</p>','published','2026-11-01T00:00:00Z')`).run();
  const insI = db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, content, published, visibility)
                           VALUES ('reply','p1',?,?,'Iemand',?,'2026-11-02T00:00:00Z',?)`);
  insI.run(`${VRIEND}/r/open`, VRIEND, '<p>openbaar antwoord</p>', 'public');
  insI.run(`${VRIEND}/r/vriend`, VRIEND, '<p>vriendenantwoord van een ander</p>', 'followers');
  insI.run(`${VRIEND}/r/onbekend`, VRIEND, '<p>uit een oud archief</p>', 'onbekend');
  const insO = db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, post_slug, in_reply_to, to_actor, content, visibility, created_at)
                           VALUES (?, 'ik', 'p1', 'p1', ?, ?, ?, ?, '2026-11-03 10:00:00')`);
  insO.run('o-open', `${VRIEND}/r/open`, VRIEND, '<p>ons openbare antwoord</p>', null);
  insO.run('o-vriend', `${VRIEND}/r/open`, VRIEND, '<p>ons vriendenantwoord</p>', 'friends');
  const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();
  const tekst = JSON.stringify(AP.getInteractions('p1', 'https://klonkt.test', site));
  assert.ok(tekst.includes('openbaar antwoord') && tekst.includes('ons openbare antwoord'));
  assert.ok(!tekst.includes('vriendenantwoord van een ander'));
  assert.ok(!tekst.includes('ons vriendenantwoord'), 'ook ons eigen vriendenantwoord niet');
  assert.ok(!tekst.includes('uit een oud archief'));
});

test('het archief: de zichtbaarheid van een antwoord gaat mee, een oud archief zonder = verborgen', () => {
  const archief = AX.buildArchive('ik', { exportedAt: 'X' });
  const pad = [...archief.files.keys()].find((p) => p.startsWith('replies/') && p.includes('p1'));
  assert.ok(pad, 'de antwoorden staan in het archief');
  const coll = JSON.parse(archief.files.get(pad).toString('utf8'));
  const per = Object.fromEntries(coll.orderedItems.map((i) => [i.id, i['shaer:visibility']]));
  assert.equal(per[`${VRIEND}/r/vriend`], 'followers');
  assert.equal(per[`${VRIEND}/r/open`], 'public');

  // Terug, en nog eens met een archief van voor dit veld.
  const zonder = { ...coll, orderedItems: coll.orderedItems.map(({ 'shaer:visibility': _weg, ...rest }) => rest) };
  const oudArchief = new Map(archief.files);
  oudArchief.set(pad, Buffer.from(JSON.stringify(zonder)));
  for (const [files, verwacht] of [[archief.files, 'followers'], [oudArchief, 'onbekend']]) {
    db.prepare('DELETE FROM posts').run();
    db.prepare('DELETE FROM ap_interactions').run();
    const r = AI.importArchive(files, { slug: 'ik' });
    assert.ok(!r.error, JSON.stringify(r.error));
    const v = db.prepare('SELECT visibility FROM ap_interactions WHERE object_uri = ?').get(`${VRIEND}/r/vriend`);
    assert.equal(v && v.visibility, verwacht);
  }
  const oudOpen = db.prepare('SELECT visibility FROM ap_interactions WHERE object_uri = ?').get(`${VRIEND}/r/open`);
  assert.equal(oudOpen.visibility, 'onbekend', 'zonder veld weten we het niet, dus ook een openbaar antwoord blijft uit het draadje');
});
