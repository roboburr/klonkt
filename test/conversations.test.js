// Gesprekken: eerst wie, dan pas wat (shaer-frontend-yso).
//
// De oude lezing gaf 60 berichten over ALLE gesprekken samen. Deze toetsen
// leggen vast wat daaraan mis was en niet meer mag terugkomen: dat een druk
// gesprek de rest wegdrukt, dat iemand daardoor uit de hemel verdwijnt, en dat
// jouw kant en hun kant apart afgekapt werden.
//
// In-memory SQLite. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'kind', 'Kind', 'u1');

const TANTE = 'https://elders/u/tante';
const OMA = 'https://elders/u/oma';
const VREEMDE = 'https://elders/u/vreemde';

const arrived = (uri, van, stamp) =>
  db.prepare(`INSERT INTO ap_mentions (slug, object_uri, actor_uri, actor_name, content, published)
              VALUES ('kind', ?, ?, 'iemand', '<p>hoi</p>', ?)`).run(uri, van, stamp);
const sent = (id, naar, stamp, visibility = 'direct') =>
  db.prepare(`INSERT INTO ap_outbox (id, site_slug, post_id, to_actor, to_actors, content, visibility, created_at)
              VALUES (?, 'kind', 'p1', ?, ?, '<p>terug</p>', ?, ?)`)
    .run(id, naar, JSON.stringify([naar]), visibility, stamp);

// Een DRUK gesprek met oma: genoeg om in de oude lezing de rest weg te drukken.
for (let i = 0; i < 80; i++) arrived(`https://elders/n/oma-${i}`, OMA, `2026-08-09T10:${String(i % 60).padStart(2, '0')}:00Z`);
// En een stil gesprek met tante, ouder dan al die drukte.
arrived('https://elders/n/tante-1', TANTE, '2026-08-01T09:00:00Z');
sent('mijn-1', TANTE, '2026-08-01T09:30:00Z');
// Een PUBLIEK antwoord aan een vreemde is geen gesprek.
sent('mijn-publiek', VREEMDE, '2026-08-09T12:00:00Z', 'public');

test('de oude lezing verliest tante achter een druk gesprek -- dat is de bug', () => {
  const oud = AP.getDirectMessages('kind', 60);
  assert.equal(oud.length, 60);
  assert.ok(!oud.some((m) => m.actor_uri === TANTE), 'tante valt buiten de 60');
});

test('een rij per tegenpartij, hoe druk de drukste ook is', () => {
  const heads = AP.conversationHeads('kind');
  assert.deepEqual(heads.map((k) => k.other), [OMA, TANTE], 'nieuwste gesprek eerst, allebei aanwezig');
});

test('een publiek antwoord is geen gesprek en wordt geen gezicht', () => {
  assert.ok(!AP.conversationHeads('kind').some((k) => k.other === VREEMDE));
});

test('het gesprek draagt beide kanten onder EEN limiet', () => {
  const talk = AP.conversationHistory('kind', TANTE, { limit: 60 });
  assert.equal(talk.rows.length, 2);
  assert.deepEqual(talk.rows.map((r) => r.direction), ['out', 'in'], 'nieuwste eerst, mijn antwoord bovenaan');
  assert.equal(talk.more, false);
});

test('load more: er is een cursor en een eerlijk antwoord op "is er meer"', () => {
  // De 80 berichten van oma delen stempels (i % 60), en dat is met opzet:
  // twee berichten in dezelfde seconde is bij DM's een gesprek, geen randgeval.
  const first = AP.conversationHistory('kind', OMA, { limit: 30 });
  assert.equal(first.rows.length, 30);
  assert.equal(first.more, true, 'er is meer, en dat mag de client weten');

  const second = AP.conversationHistory('kind', OMA, { limit: 30, before: first.oldest });
  assert.equal(second.rows.length, 30);
  // Geen overlap en geen gat: de second pagina begint waar de first ophield.
  const ids = new Set(first.rows.map((r) => r.ref));
  assert.ok(second.rows.every((r) => !ids.has(r.ref)), 'geen dubbele');

  const third = AP.conversationHistory('kind', OMA, { limit: 30, before: second.oldest });
  assert.equal(third.rows.length, 20, 'de staart');
  assert.equal(third.more, false, 'en dan is het op');
  // Alles bij elkaar: precies 80, geen dubbele en niets overgeslagen. Met een
  // cursor op alleen de stempel zou de grensseconde hier stil wegvallen.
  const allRefs = new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.ref));
  assert.equal(allRefs.size, 80, 'elke berichtje precies een keer');
});

// ── Door de routes heen, want daar wordt de vorm beslist ────────────
test('de gesprekslezingen: een rij per persoon, en een gesprek met next', async (t) => {
  const crypto = await import('crypto');
  const express = (await import('express')).default;
  const routes = (await import('../src/routes/activitypub.js')).default;

  const bearer = 'test-token-' + 'e'.repeat(24);
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(bearer).digest('base64url'), 'c', 'u1', 'kind', 'read write');

  const app = express();
  app.use(routes);
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once('listening', r));
  const get = async (pad) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${pad}`,
      { headers: { Authorization: `Bearer ${bearer}` } });
    return { status: r.status, body: await r.json() };
  };
  const slug = '/ap/users/kind';

  const list = await get(`${slug}/conversations`);
  assert.equal(list.status, 200);
  assert.equal(list.body.totalItems, 2, 'oma en tante, en niet de publieke vreemde');
  // De byline zit in de ingesloten actor, net als overal sinds shaer-nmw.
  assert.ok(list.body.orderedItems.every((i) => i.object.attributedTo));

  const first = await get(`${slug}/messages?with=${encodeURIComponent(OMA)}&limit=30`);
  assert.equal(first.body.orderedItems.length, 30);
  assert.ok(first.body.next, 'er is meer, en de standaardvorm zegt het');
  assert.ok(first.body.next.includes('limit=30'), 'de paginagrootte reist mee');

  // De next-link volgen doet wat hij belooft: geen dubbele, en uiteindelijk op.
  const path2 = first.body.next.replace(/^https?:\/\/[^/]+/, '');
  const second = await get(path2);
  const firstIds = new Set(first.body.orderedItems.map((i) => i.object.id));
  assert.ok(second.body.orderedItems.every((i) => !firstIds.has(i.object.id)), 'geen overlap');
  const third = await get(second.body.next.replace(/^https?:\/\/[^/]+/, ''));
  assert.equal(third.body.orderedItems.length, 20);
  assert.equal(third.body.next, undefined, 'op is op, en dat staat er ook');

  // Een gesprek draagt beide kanten; het eigen antwoord aan tante hoort erbij.
  const withAunt = await get(`${slug}/messages?with=${encodeURIComponent(TANTE)}`);
  assert.equal(withAunt.body.orderedItems.length, 2);
  assert.ok(withAunt.body.orderedItems.some((i) => i.actor === 'https://klonkt.test/ap/users/kind'), 'mijn eigen kant zit erin');

  const broken = await get(`${slug}/messages?with=nonsens`);
  assert.equal(broken.status, 400, 'geen actor-uri, geen gesprek');
});
