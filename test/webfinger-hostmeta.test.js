// Ontdekking: host-meta erbij, en WebFinger coulant in wat hij accepteert.
//
// Aanleiding (7/8 augustus): Funkwhale vond dev pas via zijn eigen "search via
// the fediverse". Onze kant antwoordde correct, maar twee deuren stonden dicht
// die een andere client wel gebruikt: host-meta gaf 404, en een resource zonder
// `acct:` gaf 400 terwijl we prima wisten wie er bedoeld werd.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

const app = express(); app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const wf = async (resource) => {
  const r = await fetch(`${base}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`);
  return { status: r.status, type: r.headers.get('content-type'), body: r.status === 200 ? await r.json() : null };
};

test('de nette vorm blijft werken, en het antwoord is canoniek', async () => {
  const { status, type, body } = await wf('acct:band@test.example');
  assert.equal(status, 200);
  assert.match(type, /application\/jrd\+json/);
  assert.equal(body.subject, 'acct:band@test.example');
  assert.equal(body.links.find((l) => l.rel === 'self').href, 'https://test.example/ap/users/band');
});

test('zonder acct: mag ook -- en levert hetzelfde canonieke antwoord', async () => {
  const { status, body } = await wf('band@test.example');
  assert.equal(status, 200);
  assert.equal(body.subject, 'acct:band@test.example', 'een slordige vraag geeft geen slordig antwoord');
});

test('met het apenstaartje dat mensen intypen', async () => {
  const { status, body } = await wf('@band@test.example');
  assert.equal(status, 200);
  assert.equal(body.subject, 'acct:band@test.example');
});

test('de actor-URI blijft een 400 -- vastgelegd in webfinger-bare-host', async () => {
  // Niet vergeten maar bewust: die keuze staat elders vast en draaien we niet
  // om als bijvangst van een coulance-fix.
  assert.equal((await wf('https://test.example/ap/users/band')).status, 400);
});

test('echte onzin blijft een 400, een onbekende gebruiker een 404', async () => {
  assert.equal((await wf('kaas')).status, 400);
  assert.equal((await wf('')).status, 400);
  assert.equal((await wf('acct:bestaatniet@test.example')).status, 404);
});

test('host-meta wijst naar de webfinger-sjabloon (XRD)', async () => {
  const r = await fetch(`${base}/.well-known/host-meta`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/xrd\+xml/);
  const xml = await r.text();
  assert.match(xml, /rel="lrdd"/);
  assert.match(xml, /template="https:\/\/test\.example\/\.well-known\/webfinger\?resource=\{uri\}"/);
});

test('en in JSON, want beide vormen worden gevraagd', async () => {
  const r = await fetch(`${base}/.well-known/host-meta.json`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/jrd\+json/);
  const j = await r.json();
  assert.equal(j.links[0].rel, 'lrdd');
  assert.match(j.links[0].template, /\{uri\}$/);
});

test.after(() => server.close());
