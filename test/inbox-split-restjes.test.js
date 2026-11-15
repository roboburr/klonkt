// Twee namen die bij de opsplitsing van de inbox achterbleven (shaer-yn3l).
//
// ap-inbox.js werd uit ActivityPubService.js gehaald, en twee regels verwezen
// daarna naar iets dat alleen in de dienst bestond. Allebei een ReferenceError
// die een catch stil inslikte, dus niemand zag het:
//
//  1. Een gepoorte Follow op een ward las `guardians.length` -- daar heet de
//     lijst `wardGuardians`. Het viel in de .then van fetchActor, dus een
//     REMOTE guardian kreeg de Offer(Follow) nooit (FEP-633c §5.3). De volger
//     wachtte op een besluit dat niemand kon nemen.
//  2. Een volger die opnieuw volgt hoort zijn naam en icoon bij te werken;
//     `_updFDisp` was module-privé in de dienst, dus dat gebeurde nooit.
//
// De fetch is gestubd: het gaat om WAT er de deur uit gaat, niet om echte HTTP.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = (await import('../src/services/ActivityPubService.js')).default;
const G = await import('../src/services/guardianship/index.js');
const { commitGuardianForWard } = await import('../src/services/guardianship/relations.js');

db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES ('u1','u1','u1@t','x','god')").run();
db.prepare("INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES ('s1','kind','Kind','u1',1)").run();
db.prepare("INSERT INTO sites (id, slug, title, owner_id, is_public, approve_followers) VALUES ('s2','open','Open','u1',1,0)").run();

// IP-literals: safeFetch slaat de DNS-lookup over en de stub vangt de rest.
const OMA = 'https://203.0.113.91/ap/users/oma';
const VREEMDE = 'https://203.0.113.90/ap/users/vreemde';
const VOLGER = 'https://203.0.113.92/ap/users/volger';
commitGuardianForWard('kind', OMA);

const actoren = {
  [OMA]: { id: OMA, type: 'Person', preferredUsername: 'oma', inbox: `${OMA}/inbox` },
  [VREEMDE]: { id: VREEMDE, type: 'Person', preferredUsername: 'vreemde', inbox: `${VREEMDE}/inbox` },
  [VOLGER]: { id: VOLGER, type: 'Person', preferredUsername: 'volger', name: 'Oude Naam', inbox: `${VOLGER}/inbox` },
};
const bezorgd = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'POST') {
    try { bezorgd.push({ naar: u, activiteit: JSON.parse(opts.body) }); } catch { /* niet-JSON telt niet mee */ }
    return new Response('', { status: 202 });
  }
  const doc = actoren[u];
  if (!doc) return new Response('', { status: 404 });
  return new Response(JSON.stringify(doc), { status: 200, headers: { 'content-type': 'application/activity+json' } });
};
after(() => { globalThis.fetch = echteFetch; });

const follow = (van, slug, id) => AP.handleInbox({
  body: {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id, type: 'Follow', actor: van, object: `https://klonkt.test/ap/users/${slug}`,
  },
  headers: {}, get: () => undefined, socket: {},
}, slug, { id: van });

// De bezorging is fire-and-forget: wacht tot hij er is, of geef het op.
async function wachtOp(pred, ms = 2000) {
  const tot = Date.now() + ms;
  while (Date.now() < tot) {
    const hit = bezorgd.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test('een gepoorte Follow op een ward gaat als Offer naar de REMOTE guardian', async () => {
  bezorgd.length = 0;
  assert.equal(await follow(VREEMDE, 'kind', `${VREEMDE}#follow-kind`), 202);
  const wachtend = G.follows.listForWard('kind');
  assert.equal(wachtend.length, 1, 'de Follow wacht op de guardians');
  assert.equal(wachtend[0].follower_uri, VREEMDE);

  const offer = await wachtOp((b) => b.activiteit.type === 'Offer');
  assert.ok(offer, 'oma heeft een Offer(Follow) gekregen');
  assert.equal(offer.naar, `${OMA}/inbox`);
  const a = offer.activiteit;
  assert.equal(a.actor, 'https://klonkt.test/ap/users/kind');
  assert.deepEqual(a.to, [OMA]);
  assert.equal(a['shaer:followApproval'], true);
  assert.equal(a.object.type, 'Follow');
  assert.equal(a.object.id, `${VREEMDE}#follow-kind`);
  assert.equal(a.object.actor, VREEMDE);
  // Eén guardian: drempel 1, dus haar antwoord beslist (shaer-8vt).
  assert.equal(a['shaer:decisive'], true);
  assert.equal(bezorgd.some((b) => b.activiteit.type === 'Accept'), false, 'en de vreemde is NIET geaccepteerd');
});

test('wie opnieuw volgt, werkt zijn naam bij in de volgerslijst', async () => {
  const naam = () => db.prepare('SELECT name FROM ap_followers WHERE slug = ? AND actor_uri = ?').get('open', VOLGER)?.name;
  await follow(VOLGER, 'open', `${VOLGER}#follow-1`);
  assert.equal(naam(), 'Oude Naam');
  actoren[VOLGER] = { ...actoren[VOLGER], name: 'Nieuwe Naam' };
  await follow(VOLGER, 'open', `${VOLGER}#follow-2`);
  assert.equal(naam(), 'Nieuwe Naam', 'de tweede Follow ververst de weergave');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ap_followers WHERE slug = ? AND actor_uri = ?').get('open', VOLGER).n, 1, 'en het blijft één volger');
});
