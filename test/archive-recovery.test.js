// Herstel uit andermans tijdlijn-cache (shaer-l1v).
//
// De opzet bootst de boiert-situatie na: een verloren site waarvan de posts nog
// in de ap_timeline van een volgende instance staan, en waarvan de mediamap de
// ramp wel heeft overleefd.
//
// De zwaarste toets is de KETTING: cache -> herstelarchief -> importer -> posts.
// Er is met opzet geen apart herstelpad; als die ketting niet sluit is het hele
// idee van een gedeeld formaat niets waard.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://boiert.eu';
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'klonkt-herstel-'));
process.env.MEDIA_PATH = MEDIA;

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AR = await import('../src/services/ArchiveRecoveryService.js');
const AI = await import('../src/services/ArchiveImportService.js');

const ACTOR = 'https://boiert.eu/ap/users/boiert';
const werk = fs.mkdtempSync(path.join(os.tmpdir(), 'klonkt-bron-'));

// De GEREDDE mediamap van de verloren site: de database is weg, de bestanden niet.
const GERED = path.join(werk, 'gered-media');
fs.mkdirSync(path.join(GERED, 'post-images'), { recursive: true });
const COVER = Buffer.from('bytes-van-de-cover-van-boiert');
fs.writeFileSync(path.join(GERED, 'post-images', 'cover.webp'), COVER);

/** Een tijdlijn-cache van een instance die boiert volgt. */
function maakBron(naam, rijen) {
  const p = path.join(werk, naam);
  const s = new Database(p);
  s.exec(`CREATE TABLE ap_timeline (id TEXT NOT NULL, slug TEXT NOT NULL, author_uri TEXT, author_name TEXT,
          author_handle TEXT, author_icon TEXT, author_url TEXT, content TEXT, url TEXT, published TEXT,
          media_json TEXT, created_at DATETIME, boosted INTEGER, liked INTEGER, nsfw INTEGER, cw TEXT,
          reblog_name TEXT, poll_json TEXT, quote_json TEXT, emoji_json TEXT, embed_json TEXT, UNIQUE(slug, id))`);
  const ins = s.prepare(`INSERT INTO ap_timeline (id, slug, author_uri, content, url, published, media_json, nsfw, cw, poll_json, quote_json)
                         VALUES (@id,'volger',@author_uri,@content,@url,@published,@media_json,@nsfw,@cw,@poll_json,@quote_json)`);
  for (const r of rijen) {
    ins.run({
      author_uri: ACTOR, content: '', url: null, published: null, media_json: null,
      nsfw: 0, cw: null, poll_json: null, quote_json: null, ...r,
    });
  }
  s.close();
  return p;
}

const BRON = maakBron('sound-fabrics.sqlite', [
  {
    id: 'https://boiert.eu/ap/notes/post-1',
    content: '<p><strong>Back to 1987!</strong></p><p>Rick Astley in een AI-cover.</p>',
    url: 'https://boiert.eu/waiting-on-you',
    published: '2026-04-24T06:32:45.000Z',
    media_json: JSON.stringify([{ url: 'https://boiert.eu/media/post-images/cover.webp', type: 'image/webp', name: 'de hoes' }]),
  },
  {
    id: 'https://boiert.eu/ap/notes/post-2',
    content: '<p>Een korte post zonder titel.</p>',
    url: 'https://boiert.eu/kort',
    published: '2026-05-01T10:00:00.000Z',
    cw: 'spoiler', nsfw: 1,
  },
  {
    id: 'https://boiert.eu/ap/notes/post-3',
    content: '<p><strong>Stemming</strong></p><p>Wat wordt het?</p>',
    url: 'https://boiert.eu/stemming',
    published: '2026-05-02T10:00:00.000Z',
    poll_json: JSON.stringify({ multiple: false, options: [{ name: 'ja', count: 3 }, { name: 'nee', count: 1 }], endTime: '2026-05-09T10:00:00Z', closed: true }),
  },
  // Iemand ANDERS in dezelfde tijdlijn: die hoort er niet in.
  { id: 'https://elders.test/ap/notes/x', author_uri: 'https://elders.test/users/iemand', content: '<p>niet van boiert</p>', url: 'https://elders.test/x' },
]);

// Een tweede volger die verder terug gaat: de vereniging dekt meer dan een bron.
const BRON2 = maakBron('tweede.sqlite', [
  {
    id: 'https://boiert.eu/ap/notes/post-0',
    content: '<p><strong>De oudste</strong></p><p>van voor de andere volger.</p>',
    url: 'https://boiert.eu/de-oudste',
    published: '2026-01-05T09:00:00.000Z',
  },
  // Dezelfde post als in bron 1, maar afgekapt: de RIJKSTE versie hoort te winnen.
  {
    id: 'https://boiert.eu/ap/notes/post-1',
    content: '<p><strong>Back to 1987!</strong></p>',
    url: 'https://boiert.eu/waiting-on-you',
    published: '2026-04-24T06:32:45.000Z',
  },
]);

const herstel = (extra = {}) => AR.recoverFromCache({
  sources: [BRON, BRON2], actorUri: ACTOR, mediaRoot: GERED, exportedAt: 'X', ...extra,
});

test('alleen de posts van de verloren actor komen mee', () => {
  const { rapport, files } = herstel();
  assert.equal(rapport.posts, 4);
  assert.equal(files.has('posts/x.json'), false, 'andermans post hoort er niet in');
  assert.ok(files.has('posts/post-1.json'));
});

test('de AP-ids blijven staan -- daar hangt het hele herstel aan', () => {
  const { files, manifest } = herstel();
  const o = JSON.parse(files.get('posts/post-1.json').toString());
  assert.equal(o.id, 'https://boiert.eu/ap/notes/post-1');
  assert.equal(manifest.origin, 'https://boiert.eu', 'anders weigert de importer de ids te behouden');
});

test('de titel wordt uit de tekst gevist en de rest blijft heel', () => {
  const o = JSON.parse(herstel().files.get('posts/post-1.json').toString());
  assert.equal(o.name, 'Back to 1987!');
  assert.equal(o.type, 'Article');
  assert.equal(o.content, '<p>Rick Astley in een AI-cover.</p>');
  assert.equal(o['shaer:slug'], 'waiting-on-you', 'de slug komt uit de permalink, niet uit de titel');
});

test('een post zonder vetgedrukte openingsregel houdt zijn hele tekst', () => {
  const o = JSON.parse(herstel().files.get('posts/post-2.json').toString());
  assert.equal(o.name, undefined);
  assert.equal(o.type, 'Note');
  assert.equal(o.content, '<p>Een korte post zonder titel.</p>');
  assert.equal(o.summary, 'spoiler');
  assert.equal(o.sensitive, true);
});

test('met --houd-titel blijft de tekst onaangeroerd', () => {
  // Er is geen sluitend signaal dat een vetgedrukte eerste regel een titel was,
  // dus er moet een uitweg zijn.
  const o = JSON.parse(herstel({ houdTitelInTekst: true }).files.get('posts/post-1.json').toString());
  assert.equal(o.name, undefined);
  assert.match(o.content, /<strong>Back to 1987!<\/strong>/);
});

test('de media komen van de geredde schijf, niet uit de cache', () => {
  // De cache bewaart alleen URL's. De bytes overleefden de ramp los van de
  // database, en het URL-pad is de sleutel ertussen.
  const { files, rapport } = herstel();
  const a = JSON.parse(files.get('posts/post-1.json').toString()).attachment[0];
  assert.equal(a['shaer:availability'], 'included');
  assert.equal(a['shaer:role'], 'cover');
  assert.deepEqual(files.get(a.url), COVER);
  assert.equal(rapport.media, 1);
});

test('zonder geredde mediamap wordt het gat benoemd, niet verzwegen', () => {
  const { files, rapport } = herstel({ mediaRoot: null });
  const a = JSON.parse(files.get('posts/post-1.json').toString()).attachment[0];
  assert.equal(a['shaer:availability'], 'missing');
  assert.equal(a['shaer:originalUrl'], 'https://boiert.eu/media/post-images/cover.webp');
  assert.equal(rapport.mediaMissing, 1);
});

test('een poll overleeft, inclusief dat hij gesloten was', () => {
  const o = JSON.parse(herstel().files.get('posts/post-3.json').toString());
  assert.equal(o.type, 'Question');
  assert.deepEqual(o.oneOf.map((x) => x.name), ['ja', 'nee']);
  assert.equal(o.closed, true);
  assert.equal(o.endTime, '2026-05-09T10:00:00Z');
});

test('twee bronnen samen dekken meer, en de rijkste versie wint', () => {
  const { files, rapport } = herstel();
  assert.ok(files.has('posts/post-0.json'), 'alleen de tweede volger had deze');
  assert.match(JSON.parse(files.get('posts/post-1.json').toString()).content, /Rick Astley/,
    'de afgekapte versie uit de tweede bron mag de volledige niet overschrijven');
  assert.equal(rapport.bronnen.length, 2);
});

test('het manifest zegt dat dit GERECONSTRUEERD is en wat er mist', () => {
  // Anders ziet iemand dit over een jaar aan voor een gewone export en denkt hij
  // dat de site compleet is.
  const m = herstel().manifest;
  assert.equal(m['shaer:recovered'].from, 'timeline-cache');
  assert.deepEqual(m['shaer:recovered'].window, { oldest: '2026-01-05T09:00:00.000Z', newest: '2026-05-02T10:00:00.000Z' });
  assert.match(m['shaer:recovered'].missing.join(' '), /replies/);
});

test('DE KETTING: cache -> archief -> importer -> posts', () => {
  // Bewust geen eigen herstelpad. Zou dit niet sluiten, dan was het gedeelde
  // formaat een papieren afspraak.
  db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'boiert', 'b@test', 'x', 'god');
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'boiert', 'Boiert', 'u1');

  const r = AI.importArchive(herstel().files, { slug: 'boiert' });
  assert.equal(r.idsBehouden, true, 'zelfde origin, dus de boosts elders vinden hun post terug');
  assert.equal(r.posts, 4);

  const p = db.prepare("SELECT * FROM posts WHERE id = 'post-1'").get();
  assert.ok(p, 'het oorspronkelijke post-id staat er weer');
  assert.equal(p.title, 'Back to 1987!');
  assert.equal(p.slug, 'waiting-on-you');
  assert.equal(p.status, 'published');
  assert.equal(p.cover_image_url, '/media/post-images/cover.webp');
  assert.deepEqual(fs.readFileSync(path.join(MEDIA, 'post-images', 'cover.webp')), COVER);

  const q = db.prepare("SELECT poll_json FROM posts WHERE id = 'post-3'").get();
  assert.equal(JSON.parse(q.poll_json).closed, true);
});

test('gehoste audio wordt ook teruggevonden, van een ANDERE map', () => {
  // Op echte cachedata bleek een deel van de bijlagen niet via /media/ te lopen
  // maar via /audio/stream/<bestandsnaam>, en dat is AUDIO_DIR -- een andere map
  // naast de mediamap. Zonder dit blijft de halve muziekcatalogus liggen.
  const AUDIO = path.join(werk, 'gered-audio');
  fs.mkdirSync(AUDIO, { recursive: true });
  const MP3 = Buffer.from('nep-mp3-bytes');
  fs.writeFileSync(path.join(AUDIO, 'track.mp3'), MP3);
  const bron = maakBron('audio.sqlite', [{
    id: 'https://boiert.eu/ap/notes/post-audio',
    content: '<p>luister</p>',
    url: 'https://boiert.eu/luister',
    published: '2026-06-01T10:00:00.000Z',
    media_json: JSON.stringify([{ url: 'https://boiert.eu/audio/stream/track.mp3', type: 'audio/mpeg' }]),
  }]);
  const uit = AR.recoverFromCache({ sources: [bron], actorUri: ACTOR, mediaRoot: GERED, audioRoot: AUDIO, exportedAt: 'X' });
  const a = JSON.parse(uit.files.get('posts/post-audio.json').toString()).attachment[0];
  assert.equal(a['shaer:availability'], 'included');
  assert.deepEqual(uit.files.get(a.url), MP3);

  // En het moet ook de import overleven: het bestand hoort ergens te landen EN
  // vanuit de kolommen vindbaar te zijn, niet alleen weggeschreven.
  const r = AI.importArchive(uit.files, { slug: 'boiert' });
  assert.equal(r.media, 1);
  const p = db.prepare("SELECT c2s_attachments, cover_image_url FROM posts WHERE id = 'post-audio'").get();
  const plek = p.cover_image_url;
  assert.ok(plek && plek.startsWith('/media/'), `de bijlage hoort een plek te hebben, kreeg ${plek}`);
  assert.ok(fs.existsSync(path.join(MEDIA, plek.slice('/media/'.length))), 'en daar hoort het bestand te staan');
});

test('zonder actor weigert hij te beginnen', () => {
  assert.throws(() => AR.recoverFromCache({ sources: [BRON] }), /actorUri is verplicht/);
});

test('een onleesbare bron stopt het herstel niet, maar wordt wel gemeld', () => {
  const { rapport } = AR.recoverFromCache({ sources: [BRON, path.join(werk, 'bestaat-niet.sqlite')], actorUri: ACTOR, exportedAt: 'X' });
  assert.ok(rapport.posts > 0);
  assert.match(rapport.waarschuwingen.join(' '), /niet te openen/);
});

test.after(() => {
  for (const d of [MEDIA, werk]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* niets */ } }
});
