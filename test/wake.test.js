// Wakker worden (shaer-xzab.4 en .5): een Klonkt die niet altijd aan staat,
// kondigt zich bij terugkomst aan en haalt in wat hij miste.
//
// Wat hier bewaakt wordt:
//   - wakker worden herkennen: na AWAY_MS stilte, bij het opstarten of als
//     sprong tussen twee ticks -- en NIET bij een gewone herstart;
//   - eerst aankondigen (een actor-Update per site), dan inhalen;
//   - inhalen alleen bij geaccepteerde volgrelaties, vanaf het wegvallen, met
//     een venster van een week en een maximum per account;
//   - backfillFromOutbox met `since` neemt alleen wat daarna kwam, tegen een
//     echte outbox op 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

// Een andere server met een actor en een outbox, vóór het laden van de modules
// (AP_ALLOW_HOSTS wordt bij het laden gelezen).
const NU = Date.now();
const uurGeleden = (u) => new Date(NU - u * 3600 * 1000).toISOString();
let outboxItems = [];
const ander = http.createServer((req, res) => {
  const host = `http://${req.headers.host}`;
  res.setHeader('Content-Type', 'application/activity+json');
  if (req.url === '/users/anna') {
    return res.end(JSON.stringify({ id: `${host}/users/anna`, type: 'Person', preferredUsername: 'anna', inbox: `${host}/users/anna/inbox`, outbox: `${host}/users/anna/outbox` }));
  }
  if (req.url === '/users/anna/outbox') {
    return res.end(JSON.stringify({ type: 'OrderedCollection', orderedItems: outboxItems }));
  }
  res.statusCode = 404; res.end();
});
await new Promise((r) => ander.listen(0, '127.0.0.1', r));
const anderHost = `127.0.0.1:${ander.address().port}`;
process.env.AP_ALLOW_HOSTS = anderHost;
test.after(() => ander.close());

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const W = await import('../src/services/wake.js');
const AP = await import('../src/services/ActivityPubService.js');
const { setSetting } = await import('../src/services/SettingsService.js');

// ── Herkennen ────────────────────────────────────────────────────

test('een herstart is geen terugkomst, een half uur stilte wel', () => {
  assert.equal(W.absence(null, NU), null, 'een eerste start is geen terugkomst');
  assert.equal(W.absence(NU - 10_000, NU), null, 'npm herstart na een opgeslagen wijziging');
  assert.equal(W.absence(NU - W.AWAY_MS + 1000, NU), null);
  assert.deepEqual(W.absence(NU - W.AWAY_MS, NU), { since: NU - W.AWAY_MS, awayMs: W.AWAY_MS });
});

test('een sprong tussen twee ticks is wakker worden, gewone ticks niet', () => {
  W._resetForTests();
  const gezien = [];
  const wek = (since, now) => gezien.push({ since, now });
  W.tick(NU, wek);
  W.tick(NU + 60_000, wek);
  assert.deepEqual(gezien, [], 'elke minuut een tik: niets aan de hand');
  W.tick(NU + 60_000 + 45 * 60_000, wek);           // deksel dicht, 45 minuten
  assert.deepEqual(gezien, [{ since: NU + 60_000, now: NU + 60_000 + 45 * 60_000 }], 'weg sinds de vorige tik');
  W._resetForTests();
});

test('bij het opstarten telt hoe lang we uit stonden, en dat overleeft de herstart', () => {
  const gezien = [];
  setSetting('last_alive_at', String(Date.now() - 2 * 3600 * 1000));
  W._resetForTests();
  W.startWakeWatch((since) => gezien.push(since));
  W._resetForTests();
  assert.equal(gezien.length, 1, 'twee uur uit: wakker worden');

  gezien.length = 0;
  W.startWakeWatch((since) => gezien.push(since));   // meteen weer: het teken is net gezet
  W._resetForTests();
  assert.equal(gezien.length, 0, 'en een herstart vlak daarna niet');
});

// ── De routine ───────────────────────────────────────────────────

test('eerst aankondigen, dan inhalen, vanaf het wegvallen', async () => {
  const log = [];
  const sinds = NU - 3 * 3600 * 1000;
  const r = await W.runWake({ since: sinds, now: NU }, {
    sites: () => [{ slug: 'een' }, { slug: 'twee' }],
    deliverActorUpdate: async (s) => { log.push(`update:${s.slug}`); },
    following: (slug) => (slug === 'een' ? ['https://a/u/1', 'https://b/u/2'] : []),
    backfill: async (slug, actor, limit, opts) => { log.push(`inhalen:${slug}:${actor}:${limit}:${opts.since}`); return 2; },
    pause: async () => {},
  });
  assert.deepEqual(log, [
    'update:een', 'update:twee',
    `inhalen:een:https://a/u/1:${W.CATCHUP_PER_ACCOUNT}:${sinds}`,
    `inhalen:een:https://b/u/2:${W.CATCHUP_PER_ACCOUNT}:${sinds}`,
  ]);
  assert.deepEqual(r, { announced: 2, fetched: 2, added: 4 });
});

test('een week weg wordt geen storm: venster en maximum', async () => {
  assert.equal(W.catchupSince(NU - 30 * 24 * 3600 * 1000, NU), NU - W.CATCHUP_MAX_WINDOW_MS);
  let gevraagd = 0;
  await W.runWake({ since: NU - 1, now: NU }, {
    sites: () => [{ slug: 'veel' }],
    deliverActorUpdate: async () => {},
    following: () => Array.from({ length: 500 }, (_, i) => `https://x/u/${i}`),
    backfill: async () => { gevraagd++; return 0; },
    pause: async () => {},
  });
  assert.equal(gevraagd, W.CATCHUP_MAX_ACCOUNTS);
});

test('een site die niet lukt, houdt de rest niet op', async () => {
  const log = [];
  await W.runWake({ since: NU - 3600_000, now: NU }, {
    sites: () => [{ slug: 'stuk' }, { slug: 'goed' }],
    deliverActorUpdate: async (s) => { if (s.slug === 'stuk') throw new Error('kapot'); log.push(s.slug); },
    following: () => [],
    backfill: async () => 0,
    pause: async () => {},
  });
  assert.deepEqual(log, ['goed']);
});

test('alleen geaccepteerde volgrelaties worden ingehaald', () => {
  db.prepare("INSERT INTO ap_following (slug, actor_uri, status) VALUES ('kind', 'https://a/u/ja', 'accepted'), ('kind', 'https://a/u/wacht', 'pending')").run();
  assert.deepEqual(W.acceptedFollowing('kind'), ['https://a/u/ja']);
});

// ── backfillFromOutbox met since ─────────────────────────────────

test('inhalen neemt alleen wat na het wegvallen kwam', async () => {
  const anna = `http://${anderHost}/users/anna`;
  const note = (id, published) => ({ type: 'Create', object: { id: `http://${anderHost}/notes/${id}`, type: 'Note', attributedTo: anna, content: `<p>${id}</p>`, ...(published ? { published } : {}) } });
  outboxItems = [note('vers', uurGeleden(1)), note('oud', uurGeleden(72)), note('zonder-datum', null)];
  const stil = console.log; console.log = () => {};
  let added;
  try { added = await AP.backfillFromOutbox('kind', anna, 40, { since: NU - 2 * 3600 * 1000 }); } finally { console.log = stil; }
  assert.equal(added, 1);
  const ids = db.prepare("SELECT id FROM ap_timeline WHERE slug = 'kind'").all().map((r) => r.id);
  assert.deepEqual(ids, [`http://${anderHost}/notes/vers`]);
});

test('zonder since gaat inhalen als vroeger', async () => {
  const anna = `http://${anderHost}/users/anna`;
  outboxItems = [{ type: 'Note', id: `http://${anderHost}/notes/x1`, attributedTo: anna, content: 'x', published: uurGeleden(500) }];
  const stil = console.log; console.log = () => {};
  try { assert.equal(await AP.backfillFromOutbox('ander', anna), 1); } finally { console.log = stil; }
});
