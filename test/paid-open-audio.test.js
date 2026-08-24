// Opengezette audio onder een BETAALDE post (Robin, 24-8).
//
// Aanleiding: boiert.eu/introducing-this-machine — een mixtape, betaald, met
// `fedi_open` audio. De vroege return in buildNote gooide ALLE bijlagen weg,
// dus ook het Mixtape-object. De nummers federeerden ondertussen gewoon los als
// eigen Audio-objecten met hun `context` naar die post, en in de hub viel het
// bandje daardoor uiteen in vier losse nummers onder een kale teaserkaart.
//
// Wat de poort tegenhield was dus niet inhoud maar VORM: de volgorde en het
// feit dat het een cassette is. Deze tests leggen de nieuwe grens vast:
//   - de tekst blijft achter de muur, altijd;
//   - `fedi_open` audio gaat mee, met het bandje eromheen;
//   - audio die NIET open staat gaat niet mee, ook niet als losse bijlage;
//   - en wat federeert is op de site zelf ook te horen (de poortpagina).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');
const { paidOpenAudioHtml } = await import('../src/routes/posts.js');

const BASE = 'https://ons.test';
const GEHEIM = 'DIT IS DE BETAALDE TEKST DIE NERGENS MAG STAAN';

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run('s1', 'band', 'De Band', 'u1');
const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();

// Twee open nummers in een bandje...
const media = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)');
const track = db.prepare('INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, fedi_open) VALUES (?,?,?,?,?,?,?)');
media.run('m1', 's1', 'een.mp3', 'a/een.mp3', 'audio/mpeg', 100);
media.run('m2', 's1', 'twee.mp3', 'a/twee.mp3', 'audio/mpeg', 100);
track.run('t1', 's1', 'Kant A', 'De Band', 60, 'm1', 1);
track.run('t2', 's1', 'Kant B', 'De Band', 60, 'm2', 1);
db.prepare("INSERT INTO playlists (id, site_id, title, kind) VALUES ('bandje','s1','Het Bandje','mixtape')").run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('bandje','t1',1)").run();
db.prepare("INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ('bandje','t2',2)").run();

// ...en eentje dat dicht blijft.
media.run('m9', 's1', 'dicht.mp3', 'a/dicht.mp3', 'audio/mpeg', 100);
track.run('t9', 's1', 'Gesloten', 'De Band', 60, 'm9', 0);

function maak({ id, slug, muziek, paid = 1 }) {
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, excerpt, content,
              status, published_at, paid) VALUES (?,?,?,?,?,?,?,'published',?,?)`)
    .run(id, 's1', 'u1', slug, 'Titel', 'Een teaser.',
      `<p>${GEHEIM}</p>${muziek}`, '2026-08-24T12:00:00Z', paid);
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
}

const alleTekst = (o) => JSON.stringify(o);
const bijlagen = (n) => (Array.isArray(n.attachment) ? n.attachment : (n.attachment ? [n.attachment] : []));

test('een betaald bandje federeert zijn open nummers EN de cassette', () => {
  const note = AP.buildNote(BASE, site, maak({ id: 'p1', slug: 'bandje-betaald', muziek: '<p>[[playlist:bandje]]</p>' }));
  const bij = bijlagen(note);

  const audio = bij.filter((a) => a.type === 'Audio');
  assert.equal(audio.length, 2, 'beide open nummers horen mee te reizen');
  assert.deepEqual(audio.map((a) => a.name), ['Kant A', 'Kant B']);
  assert.ok(audio.every((a) => a.url.startsWith(`${BASE}/audio/stream/`)), 'het bestand zelf, niet een link naar de poort');

  const tape = bij.find((a) => a.type === 'Mixtape');
  assert.ok(tape, 'zonder dit object valt het bandje in de hub uiteen in losse nummers');
  assert.equal(tape.totalItems, 2);
  assert.equal(tape.orderedItems.length, 2, 'de VOLGORDE is het werk; die hoort erin te staan');
});

test('en de tekst blijft ondertussen gewoon achter de muur', () => {
  const note = AP.buildNote(BASE, site, maak({ id: 'p2', slug: 'bandje-betaald-2', muziek: '<p>[[playlist:bandje]]</p>' }));
  assert.ok(!alleTekst(note).includes(GEHEIM), 'de betaalde inhoud staat nergens in het object');
  assert.match(note.content, /Een teaser/);
  assert.match(note.content, /Lees de volledige post/);
});

test('audio die NIET is opengezet reist niet mee', () => {
  const note = AP.buildNote(BASE, site, maak({ id: 'p3', slug: 'dicht', muziek: '<p>[[track:t9]]</p>' }));
  assert.equal(bijlagen(note).length, 0, 'een gesloten nummer hoort de deur niet uit te komen');
});

test('een betaalde post zonder muziek verandert niet: geen bijlagen', () => {
  const note = AP.buildNote(BASE, site, maak({ id: 'p4', slug: 'kaal', muziek: '' }));
  assert.equal(bijlagen(note).length, 0);
});

test('een gewone (niet-betaalde) post houdt dezelfde bijlagen', () => {
  // De helper wordt door BEIDE takken gebruikt; deze test bewaakt dat het
  // uitlichten ervan de gewone tak niet stilletjes heeft leeggehaald.
  const note = AP.buildNote(BASE, site, maak({ id: 'p5', slug: 'open-bandje', muziek: '<p>[[playlist:bandje]]</p>', paid: 0 }));
  const bij = bijlagen(note);
  assert.equal(bij.filter((a) => a.type === 'Audio').length, 2);
  assert.ok(bij.some((a) => a.type === 'Mixtape'), 'het bandje hangt er nog steeds aan');
  assert.ok(alleTekst(note).includes(GEHEIM), 'en de inhoud van een OPEN post federeert gewoon');
});

// ── de poortpagina op de site zelf ───────────────────────────────────────────
// Wat de hub kan afspelen hoort de site zelf ook te kunnen afspelen. Andersom
// stond de muziek overal behalve op de plek die hem uitbrengt.

test('de poort toont de speler van een open bandje', () => {
  const post = maak({ id: 'p6', slug: 'poort', muziek: '<p>[[playlist:bandje]]</p>' });
  const html = paidOpenAudioHtml(site, post, { session: null });
  assert.ok(html, 'de poort hoort hier een speler te krijgen');
  assert.ok(html.includes('Kant A') && html.includes('Kant B'), 'met de nummers erin');
  assert.ok(!html.includes(GEHEIM), 'maar NOOIT met de betaalde tekst');
  assert.ok(!html.includes('Een teaser'), 'en ook niet met de rest van de post');
});

test('de poort toont niets als de audio dicht staat', () => {
  const post = maak({ id: 'p7', slug: 'poort-dicht', muziek: '<p>[[track:t9]]</p>' });
  assert.equal(paidOpenAudioHtml(site, post, { session: null }), '');
});

test('half open is dicht: een gesloten nummer sluit de hele speler', () => {
  // Een shortcode rendert zijn hele lijst. Bij een half-open bandje zou de
  // speler ook het gesloten bestand krijgen, en /audio/stream laat een
  // gelijke-oorsprong-fetch door -- dat is een echt lek, geen theoretisch.
  const post = maak({ id: 'p8', slug: 'half', muziek: '<p>[[playlist:bandje]]</p><p>[[track:t9]]</p>' });
  assert.equal(paidOpenAudioHtml(site, post, { session: null }), '');
});

test('de poortpagina print de speler ook echt', async () => {
  const fs = await import('node:fs');
  const bron = fs.readFileSync('src/views/pages/paid-gate.ejs', 'utf8');
  assert.match(bron, /pgAudio/, 'zonder dit blijft de speler in de route steken');
  assert.match(bron, /<%- pgAudio %>/, 'ontsnapt hij, dan staat er HTML als tekst op het scherm');
});
