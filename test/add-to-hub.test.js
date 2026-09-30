// [Add to HUB] (Robin, 30-9): je klonkt vanuit Klonkt op de hub zetten.
//
// De knop zelf is een doorverwijzing naar het aanmeldformulier van de hub.
// Wat hier vast moet liggen is het stuk dat niet vanzelf spreekt: de klik
// geldt als het ja van de eigenaar voor de Follow van de hub die daarop volgt.
// Zonder dat moest de eigenaar straks zijn eigen aanmelding goedkeuren. En
// even belangrijk: die uitzondering is SMAL -- alleen de hub, alleen kort,
// en nooit langs de guardians van een ward.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
// IP-literals: safeFetch slaat dan de DNS-lookup over en de stub vangt de rest.
process.env.KLONKT_HUB_URL = 'https://203.0.113.77';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');
const HubInvite = await import('../src/services/hub-invite.js');

const HUB = 'https://203.0.113.77/ap/actor';
const ANDER = 'https://198.51.100.9/ap/actor';

db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES ('u1','u1','u1@t','x','god')").run();
const site = (id, slug) => {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, approve_followers) VALUES (?,?,?,?,1,1)').run(id, slug, slug, 'u1');
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
};

// Verkeer naar onze eigen testapp gaat echt; al het andere (de hub, een
// vreemde actor, een Accept naar een inbox) krijgt een nep-antwoord. Zonder dat
// wacht een Accept op een testadres dat nergens heen leidt.
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).startsWith('http://127.0.0.1:')) return echteFetch(url, opts);
  if (opts && opts.method === 'POST') return new Response(null, { status: 202 });
  const id = String(url).split('#')[0];
  return new Response(JSON.stringify({ id, type: 'Application', preferredUsername: 'x', inbox: `${id}/inbox` }),
    { status: 200, headers: { 'content-type': 'application/activity+json' } });
};
after(() => { globalThis.fetch = echteFetch; });

const follow = (slug, actor) => AP.handleInbox({
  body: {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${actor}#follow-${slug}`, type: 'Follow', actor,
    object: `https://klonkt.test/ap/users/${slug}`,
  },
  headers: {}, get: () => undefined, socket: {},
}, slug, { id: actor });

const volgt = (slug, actor) =>
  db.prepare('SELECT COUNT(*) c FROM ap_followers WHERE slug = ? AND actor_uri = ?').get(slug, actor).c === 1;
const wacht = (slug, actor) => G.follows.listForWard(slug).some((f) => f.follower_uri === actor);

test('zonder de knop wacht de Follow van de hub gewoon op de eigenaar', async () => {
  site('s1', 'zonder');
  await follow('zonder', HUB);
  assert.equal(volgt('zonder', HUB), false);
  assert.equal(wacht('zonder', HUB), true, 'de poort doet wat hij deed');
});

test('na de knop komt de hub er meteen door — de klik WAS het ja', async () => {
  const s = site('s2', 'met');
  HubInvite.invite(s.id);
  await follow('met', HUB);
  assert.equal(volgt('met', HUB), true, 'geen eigen aanmelding meer goedkeuren');
  assert.equal(wacht('met', HUB), false);
  assert.equal(HubInvite.onHub('met'), true, 'en dan toont /connect een bevestiging in plaats van de knop');
});

test('de uitnodiging geldt alleen voor de hub, niet voor wie er toevallig bij komt', async () => {
  const s = site('s3', 'smal');
  HubInvite.invite(s.id);
  await follow('smal', ANDER);
  assert.equal(volgt('smal', ANDER), false);
  assert.equal(wacht('smal', ANDER), true, 'iemand anders wacht gewoon op de eigenaar');
});

test('de uitnodiging loopt af', async () => {
  const s = site('s4', 'oud');
  db.prepare('UPDATE sites SET hub_invite_until = ? WHERE id = ?').run(Date.now() - 1000, s.id);
  await follow('oud', HUB);
  assert.equal(volgt('oud', HUB), false);
  assert.equal(wacht('oud', HUB), true);
});

test('een opnieuw verstuurde Follow binnen de dag struikelt niet over de poort', async () => {
  // Opgebruikt bij de eerste Follow zou een retry van de hub alsnog een
  // wachtend verzoek geven voor iets dat al beslist was.
  await follow('met', HUB);
  assert.equal(wacht('met', HUB), false);
});

test('bij een WARD beslissen nog steeds de guardians', async () => {
  const s = site('s5', 'ward');
  db.prepare(`INSERT INTO ap_guardianships (slug, role, other_uri, status, created_at)
              VALUES ('ward', 'ward', 'https://klonkt.test/ap/users/voogd', 'accepted', CURRENT_TIMESTAMP)`).run();
  HubInvite.invite(s.id);
  await follow('ward', HUB);
  assert.equal(volgt('ward', HUB), false, 'de knop is geen sluiproute langs de guardians');
});

// ── de route achter de knop ──────────────────────────────────────────

async function metApp(slug) {
  const express = (await import('express')).default;
  const router = (await import('../src/routes/posts.js')).default;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.session = { user: { id: 'u1', role: 'god', username: 'u1' } };
    res.locals.site = db.prepare('SELECT * FROM sites WHERE slug = ?').get(slug);
    res.locals.siteUrlBase = '';
    next();
  });
  app.use('/', router);
  const server = app.listen(0);
  server.unref();
  return `http://127.0.0.1:${server.address().port}`;
}
const druk = async (slug) => fetch(`${await metApp(slug)}/connect/add-to-hub`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  signal: AbortSignal.timeout(5000),
});

test('de knop stuurt naar het vooringevulde formulier en zet de uitnodiging', async () => {
  const s = site('s6', 'knop');
  const r = await druk('knop');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://203.0.113.77/?add=knop%40klonkt.test');
  assert.equal(HubInvite.isInvited('knop', HUB), true);
  assert.ok(db.prepare('SELECT hub_invite_until FROM sites WHERE id = ?').get(s.id).hub_invite_until > Date.now());
});

test('wacht er al een verzoek van de hub, dan IS de klik het ja', async () => {
  site('s7', 'wachtend');
  G.follows.recordPending('wachtend', {
    id: `${HUB}#follow-eerder-aangemeld`, follower: HUB, inbox: `${HUB}/inbox`, sharedInbox: null,
    name: 'Hub', handle: '@hub@203.0.113.77', icon: null,
    activity: { id: `${HUB}#follow-eerder-aangemeld`, type: 'Follow', actor: HUB, object: 'https://klonkt.test/ap/users/wachtend' },
    quorum: 'owner',
  });
  const r = await druk('wachtend');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), 'https://203.0.113.77/?klonkt=wachtend%40klonkt.test',
    'niet nog eens langs het formulier: je staat er al, of bijna');
  assert.equal(volgt('wachtend', HUB), true);
  assert.equal(wacht('wachtend', HUB), false);
});

test('de Connect-pagina toont de knop, of de bevestiging als hij er al op staat', async () => {
  const ejs = (await import('ejs')).default;
  const basis = { t: (k) => k, avatar: (x) => x, connections: [], myGuardians: [], followRequests: [],
    approveFollowers: true, movedTo: null, success: null, error: null, siteUrlBase: '', site: { slug: 'x' }, safeSite: {} };
  const render = (hub, extra = {}) => ejs.renderFile('src/views/pages/connect.ejs', { ...basis, ...extra, hub });

  const nog = await render({ url: 'https://hub.test', onHub: false, ward: false });
  assert.match(nog, /action="\/connect\/add-to-hub"/, 'de knop');
  assert.match(nog, /target="_blank"/, 'in een nieuw tabblad, zodat /connect blijft staan');

  const al = await render({ url: 'https://hub.test', onHub: true, ward: false });
  assert.doesNotMatch(al, /add-to-hub/, 'geen knop voor iets dat al gebeurd is');
  assert.match(al, /tl\.hub_on/);

  const verhuisd = await render({ url: 'https://hub.test', onHub: false, ward: false }, { movedTo: 'https://elders.test/ap/users/x' });
  assert.doesNotMatch(verhuisd, /add-to-hub/, 'na een verhuizing staat de uitgaande kant op slot');
});
