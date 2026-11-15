// De deur van Playtime (shaer-ivi4), en de scope write:door die er alleen
// voor is.
//
// Wat hier vastligt: de scope wordt gecontroleerd en staat standaard dicht; de
// deur leeft alleen in het geheugen en komt nooit in de database; hij wordt
// alleen aangenomen als hij zichzelf noemt en ondertekend is met een sleutel
// die via FEP-c390 aan de actor hangt; een vervanging stuurt niets, online
// komen stuurt een Update naar de abonnees en alleen naar hen, met het
// stompje en niet het adres.
//
// In-memory SQLite. Run: npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
const BASE = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const APmod = await import('../src/services/ActivityPubService.js');
const AP = APmod.default;
const OAuth = await import('../src/services/OAuthService.js');
const { scopeLines } = await import('../src/routes/oauth.js');
const I = await import('../src/services/IdentityProof.js');
const Door = (await import('../src/services/door.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)').run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'gastheer', 'Gastheer', 'u1');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'ander', 'Ander', 'u1');

// De sleutel van Playtime, via FEP-c390 aan de gastheer gekoppeld. Voor de deur
// telt alleen de subject; de verklaring zelf is elders getoetst.
const seed = crypto.randomBytes(32);
const DID = I.didKeyFromPublicKey(I.publicKeyFromSeed(seed));
db.prepare('UPDATE sites SET identity_proofs = ? WHERE slug = ?').run(JSON.stringify([{ subject: DID }]), 'gastheer');
const vreemd = crypto.randomBytes(32);

const DEUR = `${BASE}/ap/users/gastheer/door`;
const ACTOR = `${BASE}/ap/users/gastheer`;
// De vorm die Playtime ondertekent (NiceThing, 15-11): zoals zijn c390-
// verklaring, het bewijs bovenaan met een kopie van de @context, en de kale
// did:key als verificationMethod.
const HEX = (n, c) => c.repeat(n * 2);
function deur(extra = {}, { sleutel = seed, vm } = {}) {
  const did = I.didKeyFromPublicKey(I.publicKeyFromSeed(sleutel));
  const doc = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/data-integrity/v1', { shaer: 'https://ns.klonkt.com/shaer#' }],
    id: DEUR, type: 'shaer:Door', attributedTo: ACTOR,
    'shaer:host': '2001:db8::beef', 'shaer:port': 4040,
    'shaer:doorId': HEX(16, 'a'), 'shaer:session': HEX(32, 'b'),
    ...extra,
  };
  return I.signEddsaJcs2022(doc, sleutel, {
    created: '2026-11-15T12:00:00Z', proofPurpose: 'assertionMethod',
    verificationMethod: vm || did,
  });
}

// Tokens: c2s, alleen de deur, de oude testvorm, en een van een andere site.
const tokens = {};
for (const [naam, slug, scope] of [['c2s', 'gastheer', 'c2s'], ['deur', 'gastheer', 'write:door'], ['oud', 'gastheer', 'read write'], ['ander', 'ander', 'c2s']]) {
  tokens[naam] = `test-token-${naam}-` + 'd'.repeat(24);
  db.prepare('INSERT INTO oauth_tokens (token_hash, client_id, user_id, site_slug, scope) VALUES (?,?,?,?,?)')
    .run(crypto.createHash('sha256').update(tokens[naam]).digest('base64url'), 'c', 'u1', slug, scope);
}

// Elders: een vriend die ons volgt en een vreemde. IP-literals, zodat
// safeFetch de DNS overslaat en de stub de rest vangt.
const VRIEND = 'https://203.0.113.40/users/vriend';
const VREEMDE = 'https://203.0.113.41/users/vreemde';
db.prepare('INSERT INTO ap_followers (slug, actor_uri, inbox, shared_inbox) VALUES (?,?,?,?)').run('gastheer', VRIEND, `${VRIEND}/inbox`, null);

const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;
const app = express();
app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const LOKAAL = `http://127.0.0.1:${server.address().port}`;
server.unref();

const bezorgd = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(LOKAAL)) return echteFetch(url, opts);
  if (opts.method === 'POST') {
    try { bezorgd.push({ naar: u, activiteit: JSON.parse(opts.body) }); } catch { /* geen JSON */ }
    return new Response('', { status: 202 });
  }
  const id = u.replace(/#.*$/, '');
  return new Response(JSON.stringify({ id, type: 'Person', preferredUsername: 'x', inbox: `${id}/inbox` }),
    { status: 200, headers: { 'content-type': 'application/activity+json' } });
};
after(() => { globalThis.fetch = echteFetch; server.close(); });

const lokaal = (url) => url.replace(BASE, LOKAAL);
const zet = (doc, token = tokens.deur) => echteFetch(lokaal(DEUR), {
  method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/activity+json' }, body: JSON.stringify(doc),
});
const sluit = (token = tokens.deur) => echteFetch(lokaal(DEUR), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
const haal = () => echteFetch(lokaal(DEUR));
const even = () => new Promise((r) => setTimeout(r, 60));
const inbox = (act) => AP.handleInbox({ body: act, headers: {}, get: () => undefined, socket: {} }, 'gastheer', { id: act.actor });
const volg = (wie) => inbox({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${wie}#volg-deur`, type: 'Follow', actor: wie, object: DEUR });

// ── De scope ──────────────────────────────────────────────────────

test('scope: leeg is c2s, write:door bestaat, al het andere is invalid_scope', () => {
  assert.equal(OAuth.parseScope('').scope, 'c2s');
  assert.equal(OAuth.parseScope(undefined).scope, 'c2s');
  assert.equal(OAuth.parseScope('  write:door ').scope, 'write:door');
  assert.equal(OAuth.parseScope('c2s write:door c2s').scope, 'c2s write:door');
  assert.equal(OAuth.parseScope('read').error, 'invalid_scope', 'read komt met shaer-4jb1, niet stil eerder');
  assert.equal(OAuth.parseScope('write:door bogus').error, 'invalid_scope');
  assert.deepEqual(OAuth.SCOPES_SUPPORTED, ['c2s', 'write:door']);
});

test('createCode weigert een onbekende scope in plaats van c2s te geven', () => {
  const r = OAuth.createCode({ clientId: 'c', userId: 'u1', siteSlug: 'gastheer', redirectUri: 'x.y:/cb', codeChallenge: 'a'.repeat(43), scope: 'admin' });
  assert.equal(r.error, 'invalid_scope');
});

test('het toestemmingsscherm belooft alleen wat de scope geeft', () => {
  assert.deepEqual(scopeLines(['c2s']), ['oauth.scope_read', 'oauth.scope_write']);
  assert.deepEqual(scopeLines(['write:door']), ['oauth.scope_door']);
  assert.deepEqual(scopeLines(['c2s', 'write:door']), ['oauth.scope_read', 'oauth.scope_write'], 'write dekt de deur al');
});

test('verifyBearer staat standaard dicht: een deurtoken komt nergens anders in', () => {
  const h = (n) => `Bearer ${tokens[n]}`;
  assert.equal(OAuth.verifyBearer(h('deur')), null, 'een route die niets noemt vraagt read + write');
  assert.equal(OAuth.verifyBearer(h('deur'), 'write:door').site.slug, 'gastheer');
  assert.ok(OAuth.verifyBearer(h('c2s')));
  assert.ok(OAuth.verifyBearer(h('c2s'), 'write:door'), 'c2s is alles, ook de deur');
  assert.ok(OAuth.verifyBearer(h('oud')), 'read + write blijft alles van vóór de scopes');
  assert.ok(OAuth.verifyBearer(h('oud'), 'write:door'));
});

test('een deurtoken leest de inbox niet en post niet', async () => {
  const lees = await echteFetch(`${LOKAAL}/ap/users/gastheer/inbox`, { headers: { Authorization: `Bearer ${tokens.deur}` } });
  assert.ok([401, 403].includes(lees.status), `inbox gaf ${lees.status}`);
  const post = await echteFetch(`${LOKAAL}/ap/users/gastheer/outbox`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.deur}`, 'Content-Type': 'application/activity+json' },
    body: JSON.stringify({ type: 'Note', content: 'hallo' }),
  });
  assert.ok([401, 403].includes(post.status), `outbox gaf ${post.status}`);
  const metC2s = await echteFetch(`${LOKAAL}/ap/users/gastheer/inbox`, { headers: { Authorization: `Bearer ${tokens.c2s}` } });
  assert.equal(metC2s.status, 200, 'en c2s mag het nog gewoon');
});

// ── De actor ──────────────────────────────────────────────────────

test('de actor draagt de deur als object, altijd, zonder adres', () => {
  const site = db.prepare("SELECT * FROM sites WHERE slug = 'gastheer'").get();
  assert.deepEqual(AP.buildActor(BASE, site)['shaer:door'], { id: DEUR, type: 'shaer:Door' });
  Door.set('gastheer', '{}');
  assert.deepEqual(AP.buildActor(BASE, site)['shaer:door'], { id: DEUR, type: 'shaer:Door' }, 'open of dicht: dezelfde actor');
  Door._forgetAll();
});

// ── Zetten, lezen, sluiten ────────────────────────────────────────

test('dicht is 404, en nooit uit een cache', async () => {
  const r = await haal();
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('zetten vraagt het token van de eigenaar', async () => {
  assert.equal((await zet(deur(), 'geen-token-maar-wel-lang-genoeg')).status, 403);
  assert.equal((await zet(deur(), tokens.ander)).status, 403, 'een andere site zet onze deur niet');
});

test('een deur die niet klopt wordt geweigerd, met de regel erbij', async () => {
  const fout = async (doc, err) => {
    const r = await zet(doc);
    assert.equal(r.status, 422, err);
    assert.equal((await r.json()).error, err);
  };
  await fout(deur({ id: `${BASE}/ap/users/ander/door` }), 'id_is_not_this_door');
  await fout(deur({ attributedTo: `${BASE}/ap/users/ander` }), 'attributedTo_is_not_this_actor');
  await fout(deur({}, { sleutel: vreemd }), 'key_not_linked_to_actor');
  const vervalst = deur();
  vervalst['shaer:host'] = '2001:db8::bad';
  await fout(vervalst, 'bad_signature');
  const { proof, ...kaal } = deur();
  await fout(kaal, 'no_proof');
  await fout(deur({}, { vm: 'did:web:example.com' }), 'verificationMethod_is_not_an_ed25519_did_key');
  assert.equal((await haal()).status, 404, 'niets ervan staat open');
});

test('een verificationMethod met #-fragment mag ook', async () => {
  const r = await zet(deur({}, { vm: `${DID}#${DID.slice('did:key:'.length)}` }));
  assert.equal(r.status, 201);
  assert.equal((await sluit()).status, 204);
});

test('een goede deur: 201, en GET geeft dezelfde JSON met een handtekening die klopt', async () => {
  const doc = deur();
  const r = await zet(doc);
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { id: DEUR, open: true });
  const g = await haal();
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('cache-control'), 'no-store');
  assert.match(g.headers.get('content-type'), /application\/activity\+json/);
  const terug = await g.json();
  assert.deepEqual(terug, doc);
  assert.equal(I.verifyEddsaJcs2022(terug, I.publicKeyFromDidKey(DID)), true, 'een lezer kan hem narekenen');
});

test('de deur komt nooit in de database', () => {
  const alles = db.serialize().toString('latin1');
  assert.ok(!alles.includes('2001:db8::beef'), 'geen adres op schijf');
  assert.ok(!alles.includes(HEX(32, 'b')), 'geen sessiesleutel op schijf');
});

test('abonneren kan alleen uit de lucht van de eigenaar', async () => {
  bezorgd.length = 0;
  await volg(VRIEND);
  await volg(VREEMDE);
  await even();
  assert.deepEqual(Door.subscribers('gastheer').map((r) => r.actor_uri), [VRIEND]);
  const naar = (wie) => bezorgd.find((b) => b.naar === `${wie}/inbox`);
  assert.equal(naar(VRIEND).activiteit.type, 'Accept');
  assert.equal(naar(VREEMDE).activiteit.type, 'Reject');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ap_followers WHERE slug = 'gastheer'").get().n, 1, 'een deurabonnee is geen volger');
});

test('vervangen terwijl hij open staat: 200, en niemand hoort iets', async () => {
  bezorgd.length = 0;
  const r = await zet(deur({ 'shaer:host': '2001:db8::cafe' }));
  assert.equal(r.status, 200);
  await even();
  assert.equal(bezorgd.length, 0);
  assert.equal((await (await haal()).json())['shaer:host'], '2001:db8::cafe');
});

test('sluiten: 204, daarna 404; nog eens sluiten is 404', async () => {
  assert.equal((await sluit()).status, 204);
  assert.equal((await haal()).status, 404);
  assert.equal((await sluit()).status, 404);
});

test('online komen stuurt een Update naar de abonnees, met het stompje en niet het adres', async () => {
  bezorgd.length = 0;
  assert.equal((await zet(deur({ 'shaer:doorId': HEX(16, 'c') }))).status, 201);
  await even();
  assert.equal(bezorgd.length, 1, 'alleen de vriend, niet de vreemde');
  const { naar, activiteit } = bezorgd[0];
  assert.equal(naar, `${VRIEND}/inbox`);
  assert.equal(activiteit.type, 'Update');
  assert.equal(activiteit.actor, ACTOR);
  assert.deepEqual(activiteit.to, [VRIEND]);
  assert.deepEqual(activiteit.object, { id: DEUR, type: 'shaer:Door', attributedTo: ACTOR });
  assert.ok(!JSON.stringify(activiteit).includes('2001:db8'), 'geen adres naar een andere server');
});

test('een herstart sluit de deur, maar de abonnees blijven; opnieuw zetten is online komen', async () => {
  Door._forgetAll();
  assert.equal((await haal()).status, 404);
  bezorgd.length = 0;
  assert.equal((await zet(deur())).status, 201);
  await even();
  assert.equal(bezorgd.filter((b) => b.activiteit.type === 'Update').length, 1);
});

test('Undo van het abonnement: weg, en de volgende opening stuurt niets', async () => {
  await inbox({ '@context': 'https://www.w3.org/ns/activitystreams', id: `${VRIEND}#undo`, type: 'Undo', actor: VRIEND,
    object: { id: `${VRIEND}#volg-deur`, type: 'Follow', actor: VRIEND, object: DEUR } });
  assert.deepEqual(Door.subscribers('gastheer'), []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ap_followers WHERE slug = 'gastheer'").get().n, 1, 'en hij volgt de actor nog');
  await sluit();
  bezorgd.length = 0;
  await zet(deur());
  await even();
  assert.equal(bezorgd.length, 0);
});

test('de grens laat een netwerkwissel per minuut toe, en meer niet', () => {
  const t0 = 1_000_000_000;
  for (let i = 0; i < Door.DOOR_WRITES_PER_HOUR; i++) assert.equal(Door.allowWrite('grens', t0 + i * 1000).ok, true, `poging ${i}`);
  const nee = Door.allowWrite('grens', t0 + 60_000);
  assert.equal(nee.ok, false);
  assert.ok(nee.retryAfter > 0 && nee.retryAfter <= 3600);
  assert.equal(Door.allowWrite('grens', t0 + 3600_000 + 1).ok, true, 'na een uur weer ruimte');
});

test('sluiten lukt ook als de grens bereikt is', async () => {
  for (let i = 0; i < Door.DOOR_WRITES_PER_HOUR + 2; i++) Door.allowWrite('gastheer');
  assert.equal((await zet(deur())).status, 429);
  assert.equal((await sluit()).status, 204, 'een eigenaar die sluit, moet dicht kunnen');
});
