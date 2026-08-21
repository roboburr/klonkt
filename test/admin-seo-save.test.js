// Het SEO & social-paneel opslaan, door de ECHTE route heen.
//
// Waarom deze test bestaat: in f50a84b stonden twee const-regels BINNEN de
// template-literal van de UPDATE. Geldig JavaScript -- het werd tekst in de SQL
// -- dus geen enkele lader, linter of syntaxcontrole zag er iets van. Pas bij
// het opslaan viel het om, met `near "/": syntax error`, en dan niet alleen op
// de MusicBrainz-koppeling maar op het HELE paneel: titelsjabloon, omschrijving,
// og:image, elke verificatiecode.
//
// Het gevolg was stil op de plek waar je zou kijken. Het zoekscherm werkt langs
// een aparte GET, dus de artiest verscheen netjes; alleen bewaren deed niets, en
// het actor-document liet daarom terecht geen schema:sameAs zien. Zie
// test/feed-alt-view.test.js voor dezelfde vorm: een formulierroute breekt in de
// SQL, en alleen een test die er echt doorheen gaat merkt het.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'baas', 'b@t.nl', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run('s1', 'robo', 'Soundfabrics', 'u1');

const express = (await import('express')).default;
const router = (await import('../src/routes/admin-seo.js')).default;
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.session = { user: { id: 'u1', role: 'god' } }; next(); });
app.use('/admin/seo', router);

const server = app.listen(0);
server.unref();
const poort = server.address().port;

// Met tijdslimiet: express vangt een worp in de handler niet af, dus zonder
// limiet blijft de suite hangen op precies de fout die ze moet vangen.
const post = async (velden) => {
  try {
    return await fetch(`http://127.0.0.1:${poort}/admin/seo`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(velden).toString(),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    assert.fail(`de route antwoordde niet (${e.name}) -- vrijwel altijd een worp in `
      + 'de handler, en bij dit formulier meestal de SQL zelf');
  }
};
const site = () => db.prepare('SELECT * FROM sites WHERE slug = ?').get('robo');

const MBID = 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d';

test('opslaan bewaart de MusicBrainz-koppeling', async () => {
  const r = await post({ mb_artist_id: MBID, mb_artist_name: 'Soundfabrics', schema_type: 'Person' });
  assert.ok(r.status === 302 || r.status === 200, 'opslaan mag niet stranden, kreeg ' + r.status);
  assert.equal(site().mb_artist_id, MBID);
  assert.equal(site().mb_artist_name, 'Soundfabrics');
});

test('en de rest van het paneel ook — de breuk raakte alle velden', async () => {
  await post({
    mb_artist_id: MBID,
    title_template: '{title} · {site}',
    default_description: 'Beats en alchemie',
    google_verification: 'goog-123',
    publisher_name: 'Soundfabrics',
    schema_type: 'Organization',
  });
  const s = site();
  assert.equal(s.title_template, '{title} · {site}');
  assert.equal(s.default_description, 'Beats en alchemie');
  assert.equal(s.google_verification, 'goog-123');
  assert.equal(s.publisher_name, 'Soundfabrics');
  assert.equal(s.schema_type, 'Organization');
});

test('geen MBID is ontkoppelen, en rommel komt de kolom niet in', async () => {
  await post({ mb_artist_id: MBID, mb_artist_name: 'Soundfabrics' });
  assert.equal(site().mb_artist_id, MBID, 'eerst gekoppeld');

  await post({ mb_artist_id: '', mb_artist_name: '' });
  assert.equal(site().mb_artist_id, null, 'leeg laten is ontkoppelen');

  // Een URL of een handle in plaats van een id: de zeef hoort dat te weigeren,
  // want dit veld gaat naar twee uitgangen naar buiten.
  await post({ mb_artist_id: 'https://musicbrainz.org/artist/' + MBID });
  assert.equal(site().mb_artist_id, null, 'een URL is geen MBID');
});

test('de koppeling belandt op het actor-document als schema:sameAs', async () => {
  await post({ mb_artist_id: MBID, mb_artist_name: 'Soundfabrics' });
  const AP = await import('../src/services/ActivityPubService.js');
  const actor = AP.buildActor('https://test.example', site());
  // De hele reden dat de kolom bestaat: hij hoort de draad op te gaan. Een test
  // die alleen de kolom controleert zou de tweede helft missen.
  assert.equal(actor.sameAs, `https://musicbrainz.org/artist/${MBID}`);
});
