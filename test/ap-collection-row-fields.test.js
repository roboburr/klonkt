// Elke rij die bij buildNote aankomt draagt de velden waar buildNote OP BESLIST
// (shaer-6oth, en Barts melding van 15-8).
//
// Deze fout heeft een vorm, en die vorm herhaalt zich: een route of dienst
// haalt een KOLOMMENLIJST op in plaats van SELECT *, buildNote leest een veld
// dat er niet bij zat, en `undefined` levert stilletjes het RUIMSTE gedrag op.
// Zonder fan_only/ap_visibility krijgt een besloten post `to: as:Public`; zonder
// paid slaat de redactie over en gaat de volledige tekst van een betaalde post
// mee. Er is niets dat waarschuwt: de query klopt, de bouwer klopt, en samen
// lekken ze.
//
// Daarom een LUS over de publieke collecties die posts serveren, en geen toets
// op een enkele query -- precies de reden die ap-collection-paging.test.js ook
// noemt: het gat ontstond doordat de ene plek het wel had en de andere niet, en
// een toets per plek vraagt om dezelfde vergeetachtigheid. Over HTTP, want de
// query zit in de route en die is het onderwerp.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const express = (await import('express')).default;
const routes = (await import('../src/routes/activitypub.js')).default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_public, is_primary) VALUES (?,?,?,?,1,1)')
  .run('s1', 'band', 'De Band', 'u1');

const GEHEIM = 'DIT IS DE BETAALDE TEKST';
const insPost = db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, excerpt, status, published_at, fan_only, ap_visibility, paid, paid_min_cents, pinned)
                            VALUES (?,?,?,?,?,?,?,'published',?,?,?,?,?,?)`);
// Alle drie VASTGEZET, zodat ze ook in de featured-collectie terechtkomen.
insPost.run('p-paid', 's1', 'u1', 'betaald', 'Betaald', `<p>${GEHEIM}</p>`, 'De teaser', '2026-08-01T00:00:00Z', 0, 'public', 1, 500, 3);
insPost.run('p-quiet', 's1', 'u1', 'stil', 'Stil', '<p>stil</p>', '', '2026-08-02T00:00:00Z', 0, 'quiet', 0, null, 2);
insPost.run('p-fan', 's1', 'u1', 'vrienden', 'Vrienden', '<p>alleen vrienden</p>', '', '2026-08-03T00:00:00Z', 1, 'friends', 0, null, 1);

const app = express(); app.use(routes);
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

// De publieke collecties die POSTS naar buiten dragen. Wie er een toevoegt die
// zijn rijen met een kolommenlijst ophaalt, hoort hem hier ook bij te zetten.
const COLLECTIES = ['/ap/users/band/outbox', '/ap/users/band/featured'];

/** Elke Note uit een collectie, hoe hij ook verpakt zit (Create-wrapper of kaal). */
async function notes(pad) {
  const r = await fetch(base + pad, { headers: { Accept: 'application/activity+json' } });
  assert.equal(r.status, 200, `${pad} hoort 200 te geven`);
  const body = await r.json();
  const items = body.orderedItems || body.items || [];
  return items.map((i) => (i && typeof i.object === 'object' ? i.object : i)).filter((n) => n && n.id);
}

const NOTE = (id) => `https://test.example/ap/notes/${id}`;

for (const pad of COLLECTIES) {
  test(`${pad}: een betaalde post gaat als teaser de deur uit, nooit als tekst`, async () => {
    const alles = await notes(pad);
    const n = alles.find((x) => x.id === NOTE('p-paid'));
    assert.ok(n, 'de betaalde post hoort hier te staan -- hij is publiek, alleen zijn tekst niet');
    assert.ok(!String(n.content).includes(GEHEIM),
      'zonder de kolom `paid` slaat buildNote zijn redactie over en staat de volledige tekst erin');
    assert.match(String(n.content), /supporters/i, 'in plaats daarvan de teaser met de leeslink');
    assert.match(String(n.content), /De teaser/, 'en de teaser komt uit excerpt, niet uit de verborgen tekst');
  });

  test(`${pad}: een stille post wordt niet luid geadresseerd`, async () => {
    const n = (await notes(pad)).find((x) => x.id === NOTE('p-quiet'));
    assert.ok(n, 'een quiet-post hoort in een publieke collectie te staan');
    const to = [].concat(n.to || []);
    assert.ok(!to.includes('https://www.w3.org/ns/activitystreams#Public'),
      'zonder ap_visibility zet buildNote as:Public in `to` en is stil ineens luid');
    assert.ok(to.some((a) => /\/followers$/.test(a)), 'stil = aan je volgers gericht');
  });

  test(`${pad}: een vrienden-post staat er helemaal niet in`, async () => {
    const n = (await notes(pad)).find((x) => x.id === NOTE('p-fan'));
    assert.equal(n, undefined, 'besloten hoort niet in een publiek opvraagbare collectie');
  });
}
