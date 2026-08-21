// Een blokkade wordt ook VERSTUURD (Robin, 21-8).
//
// Aanleiding: dev.klonkt.com blokkeerde de hub, en op de hub bleef het kanaal
// met alle berichten gewoon staan. De blokkade bleef namelijk binnenshuis --
// rij in ap_blocks, inhoud opruimen, volger eruit -- en de andere kant hoorde
// er nooit van. Nu gaat er een Block naar de inbox van wie je blokkeert, en
// bij opheffen een Undo(Block), zodat de weg terug openligt.
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

db.prepare("INSERT INTO users (id, username, email, password_hash, role) VALUES ('u1','u1','u1@t','x','god')").run();
db.prepare("INSERT INTO sites (id, slug, title, owner_id, is_public) VALUES ('s1','dev','Dev','u1',1)").run();
const site = () => db.prepare("SELECT * FROM sites WHERE id = 's1'").get();

// IP-literal: safeFetch slaat de DNS-lookup over en de stub vangt de rest.
const DOEL = 'https://203.0.113.80/ap/actor';
const bezorgd = [];
const echteFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (opts.method === 'POST') {
    try { bezorgd.push({ naar: u, activiteit: JSON.parse(opts.body) }); } catch { /* niet-JSON telt niet mee */ }
    return new Response('', { status: 202 });
  }
  return new Response(JSON.stringify({
    id: DOEL, type: 'Application', preferredUsername: 'hub', inbox: `${DOEL}/inbox`,
  }), { status: 200, headers: { 'content-type': 'application/activity+json' } });
};
after(() => { globalThis.fetch = echteFetch; });

test('blokkeren stuurt een Block naar de geblokkeerde', async () => {
  bezorgd.length = 0;
  const r = await AP.blockTarget(site(), DOEL);
  assert.equal(r.ok, true);
  assert.equal(db.prepare('SELECT count(*) c FROM ap_blocks WHERE target = ?').get(DOEL).c, 1, 'de blokkade staat vast');
  const blok = bezorgd.find((b) => b.activiteit.type === 'Block');
  assert.ok(blok, 'er is een Block bezorgd');
  assert.equal(blok.naar, `${DOEL}/inbox`);
  assert.equal(blok.activiteit.object, DOEL);
  assert.equal(blok.activiteit.actor, 'https://klonkt.test/ap/users/dev');
});

test('opheffen stuurt een Undo(Block), anders komt de ander nooit terug', async () => {
  bezorgd.length = 0;
  await AP.unblock(site(), DOEL);
  assert.equal(db.prepare('SELECT count(*) c FROM ap_blocks WHERE target = ?').get(DOEL).c, 0, 'de blokkade is weg');
  const undo = bezorgd.find((b) => b.activiteit.type === 'Undo');
  assert.ok(undo, 'er is een Undo bezorgd');
  assert.equal(undo.activiteit.object.type, 'Block');
  assert.equal(undo.activiteit.object.object, DOEL);
});

test('een DOMEIN-blokkade verstuurt niets: daar is geen inbox voor', async () => {
  bezorgd.length = 0;
  await AP.blockTarget(site(), 'spam.example');
  assert.equal(db.prepare("SELECT count(*) c FROM ap_blocks WHERE kind = 'domain'").get().c, 1);
  assert.equal(bezorgd.length, 0);
});

test('een onbereikbare tegenpartij houdt de blokkade niet tegen', async () => {
  const stuk = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('down'); };
  const r = await AP.blockTarget(site(), 'https://203.0.113.99/ap/actor');
  globalThis.fetch = stuk;
  assert.equal(r.ok, true, 'de blokkade staat, ook zonder bezorging');
  assert.equal(db.prepare('SELECT count(*) c FROM ap_blocks WHERE target = ?').get('https://203.0.113.99/ap/actor').c, 1);
});
