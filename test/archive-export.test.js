// De exporter (shaer-1a6), getoetst aan het formaat in docs/EXPORT-FORMAT.md.
//
// De acceptatietest uit dat document is de MOEILIJKSTE post die Klonkt kan
// maken, niet de makkelijkste: een poll met bijlagen, een quote-kaart, een
// content warning en betaalde toegang. Die staat hieronder als eerste.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

// De media-map moet bestaan voordat paths.js hem uitleest.
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'klonkt-media-'));
process.env.MEDIA_PATH = MEDIA;

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AX = await import('../src/services/ArchiveExportService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Mijn site', 'u1');

fs.mkdirSync(path.join(MEDIA, '2026'), { recursive: true });
const PLAATJE = Buffer.from('dit-zijn-de-bytes-van-een-plaatje');
fs.writeFileSync(path.join(MEDIA, '2026', 'cover.jpg'), PLAATJE);
const PLAATJE_HASH = crypto.createHash('sha256').update(PLAATJE).digest('hex');

function post(id, extra = {}) {
  const kol = {
    id, site_id: 's1', slug: id, author_id: 'u1', title: 'Titel', content: '<p>inhoud</p>',
    status: 'published', published_at: '2026-08-01 10:00:00', created_at: '2026-08-01 10:00:00',
    updated_at: '2026-08-01 10:00:00', ...extra,
  };
  const namen = Object.keys(kol);
  db.prepare(`INSERT INTO posts (${namen.join(',')}) VALUES (${namen.map(() => '?').join(',')})`)
    .run(...namen.map((n) => kol[n]));
}

const lees = (uit, pad) => JSON.parse(uit.files.get(pad).toString('utf8'));

test('de moeilijkste post overleeft de export heel', () => {
  post('zwaar', {
    title: 'Een zware post',
    content: '<p>body</p><img src="/media/2026/cover.jpg" alt="cover">',
    content_warning: 'spoiler', nsfw: 1, paid: 1, paid_min_cents: 500,
    quote_uri: 'https://mstdn.social/users/x/statuses/1', quote_actor: 'https://mstdn.social/users/x',
    poll_json: JSON.stringify({ multiple: false, options: [{ name: 'ja' }, { name: 'nee' }], endTime: '2026-08-09T10:00:00Z' }),
    language: 'nl', tags: 'muziek, code',
  });
  const uit = AX.buildArchive('me');
  const o = lees(uit, 'posts/zwaar.json');

  assert.equal(o.type, 'Question', 'een poll exporteert als Question');
  assert.deepEqual(o.oneOf.map((x) => x.name), ['ja', 'nee']);
  assert.equal(o.endTime, '2026-08-09T10:00:00Z');
  assert.equal(o.summary, 'spoiler', 'de content warning is de AS2 summary');
  assert.equal(o.sensitive, true);
  assert.equal(o.quoteUrl, 'https://mstdn.social/users/x/statuses/1');
  assert.equal(o['shaer:quoteActor'], 'https://mstdn.social/users/x');
  assert.equal(o['shaer:paidMinCents'], 500);
  assert.deepEqual(o.contentMap, { nl: '<p>body</p><img src="/media/2026/cover.jpg" alt="cover">' });
  assert.deepEqual(o.tag.map((t) => t.name), ['#muziek', '#code']);
});

test('een betaalde post exporteert de VOLLEDIGE inhoud, niet de teaser', () => {
  // buildNote() federeert bewust alleen een teaser. Zou de export die projectie
  // volgen, dan archiveer je je eigen betaalde post als samenvatting.
  const o = lees(AX.buildArchive('me'), 'posts/zwaar.json');
  assert.match(o.content, /<p>body<\/p>/);
  assert.equal(o['shaer:paid'], true);
});

test('de titel staat in name, niet in de content gebakken', () => {
  // Ook een verschil met de federatie-projectie: Mastodon negeert `name`, dus
  // daar gaat de titel de content in. Een archief hoort dat niet over te nemen.
  const o = lees(AX.buildArchive('me'), 'posts/zwaar.json');
  assert.equal(o.name, 'Een zware post');
  assert.equal(o.type, 'Question');
  assert.doesNotMatch(o.content, /<strong>Een zware post<\/strong>/);
});

test('media reizen mee als bytes, gesleuteld op hun inhoud', () => {
  const uit = AX.buildArchive('me');
  const o = lees(uit, 'posts/zwaar.json');
  const a = o.attachment[0];
  assert.equal(a['shaer:availability'], 'included');
  assert.equal(a['shaer:sha256'], PLAATJE_HASH);
  assert.equal(a.url, `media/${PLAATJE_HASH}.jpg`, 'de verwijzing is container-relatief');
  assert.equal(a['shaer:originalUrl'], 'https://klonkt.test/media/2026/cover.jpg');
  assert.deepEqual(uit.files.get(a.url), PLAATJE, 'en de bytes zitten er echt in');
});

test('een verdwenen bestand wordt gemeld, niet weggelaten', () => {
  // De derde mediastaat. Een lege medialijst zou een leugen zijn en een
  // verwijzing naar een ontbrekend bestand een kapot archief.
  post('kwijt', { content: '<p>x</p><img src="/media/2026/weg.jpg">' });
  const uit = AX.buildArchive('me');
  const a = lees(uit, 'posts/kwijt.json').attachment[0];
  assert.equal(a['shaer:availability'], 'missing');
  assert.equal(a.url, 'https://klonkt.test/media/2026/weg.jpg', 'de oorspronkelijke plek blijft staan');
  assert.equal(uit.counts.mediaMissing, 1);
  assert.equal(uit.missing[0].post, 'kwijt');
});

test('een pad buiten de media-map wordt niet gevolgd', () => {
  // Zonder deze grens trekt een verzonnen pad in oude inhoud een willekeurig
  // bestand van de schijf het archief in.
  post('sluipweg', { content: '<p>x</p><img src="/media/../../../etc/passwd">' });
  const uit = AX.buildArchive('me');
  const a = lees(uit, 'posts/sluipweg.json').attachment[0];
  assert.equal(a['shaer:availability'], 'missing');
});

test('antwoorden van anderen staan apart en zijn gemarkeerd als archief', () => {
  db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, content, created_at)
              VALUES ('reply', 'zwaar', ?, ?, 'Anna', '<p>hoi</p>', '2026-08-02 10:00:00')`)
    .run('https://mstdn.social/users/anna/statuses/9', 'https://mstdn.social/users/anna');
  const uit = AX.buildArchive('me');
  const c = lees(uit, 'replies/zwaar.json');
  assert.equal(c['shaer:archive'], true, 'hierop keert een importer: nooit opnieuw bezorgen');
  assert.equal(c.totalItems, 1);
  assert.equal(c.orderedItems[0].id, 'https://mstdn.social/users/anna/statuses/9');
  assert.equal(uit.counts.replies, 1);
});

test('een gehoste track reist mee, met de gegevens die alleen in de database staan', () => {
  // [[track:]] verwijst naar een audio_tracks-rij met een media-rij eronder. Op
  // beta staan nul tracks, dus dit pad raakt daar geen echte data -- vandaar hier.
  fs.mkdirSync(path.join(MEDIA, 'audio'), { recursive: true });
  const WAV = Buffer.from('RIFF-nep-audio');
  fs.writeFileSync(path.join(MEDIA, 'audio', 't1.mp3'), WAV);
  db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
    .run('m1', 's1', 't1.mp3', 'audio/mpeg', WAV.length, path.join(MEDIA, 'audio', 't1.mp3'));
  db.prepare(`INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, credit, license, link_spotify)
              VALUES ('tr1','s1','Kanonnen','Robin',212,'m1','opname 2026','CC BY','https://open.spotify.com/track/x')`).run();
  post('metaudio', { content: '<p>luister</p>[[track:tr1]]' });

  const uit = AX.buildArchive('me');
  const o = lees(uit, 'posts/metaudio.json');
  const a = o.attachment[0];
  assert.equal(a['shaer:availability'], 'included');
  assert.equal(a.mediaType, 'audio/mpeg');
  assert.deepEqual(uit.files.get(a.url), WAV);
  assert.match(o.content, /\[\[track:tr1\]\]/, 'de shorthand blijft in de bron staan');
  const t = o['shaer:audio'][0];
  assert.equal(t.name, 'Kanonnen');
  assert.equal(t.artist, 'Robin');
  assert.equal(t.license, 'CC BY');
  assert.deepEqual(t.url, ['https://open.spotify.com/track/x']);
});

test('de poster van een audio-bijlage gaat mee', () => {
  // Gevonden bij de export van echte beta-data: c2s_attachments draagt naast url
  // ook een poster, en die viel er stil uit.
  fs.writeFileSync(path.join(MEDIA, '2026', 'opname.m4a'), Buffer.from('audio'));
  fs.writeFileSync(path.join(MEDIA, '2026', 'opname.m4a.poster.webp'), Buffer.from('poster'));
  post('metposter', {
    c2s_attachments: JSON.stringify([{
      url: '/media/2026/opname.m4a', mediaType: 'audio/mp4', name: 'opname.m4a',
      poster: '/media/2026/opname.m4a.poster.webp',
    }]),
  });
  const o = lees(AX.buildArchive('me'), 'posts/metposter.json');
  assert.equal(o.attachment.length, 2, 'de opname en de poster');
  assert.ok(o.attachment.every((a) => a['shaer:availability'] === 'included'));
});

test('een SQL-tijdstempel wordt als UTC gelezen, niet als lokale tijd', () => {
  // SQLite schrijft CURRENT_TIMESTAMP in UTC zonder zone erbij. Date.parse leest
  // die vorm als LOKALE tijd, en dan schuift elk tijdstempel in het archief mee
  // met de machine die de export draait -- in Amsterdam twee uur.
  //
  // Deze test is alleen zinvol onder een NIET-UTC tijdzone; draai hem daarom ook
  // eens als:  TZ=Europe/Amsterdam node --test test/archive-export.test.js
  post('tijdstip', { published_at: '2026-07-01 12:56:10', created_at: '2026-07-01 12:56:10' });
  const o = lees(AX.buildArchive('me'), 'posts/tijdstip.json');
  assert.equal(o.published, '2026-07-01T12:56:10.000Z',
    'het moment uit de database is UTC en hoort dat te blijven');
});

test('een concept gaat gewoon mee', () => {
  post('concept', { status: 'draft', published_at: null });
  const o = lees(AX.buildArchive('me'), 'posts/concept.json');
  assert.equal(o['shaer:status'], 'draft');
});

test('twee exports van ongewijzigde inhoud zijn gelijk, op exportedAt na', () => {
  const a = AX.buildArchive('me', { exportedAt: 'X' });
  const b = AX.buildArchive('me', { exportedAt: 'Y' });
  assert.deepEqual([...a.files.keys()].sort(), [...b.files.keys()].sort());
  for (const pad of a.files.keys()) {
    if (pad === 'manifest.json') continue;
    assert.deepEqual(a.files.get(pad), b.files.get(pad), `${pad} verschilt`);
  }
  assert.deepEqual(a.manifest.files, b.manifest.files, 'de checksum-kaart hoort gelijk te zijn');
});

test('en de zip die eruit komt ook', () => {
  const a = AX.buildArchive('me', { exportedAt: 'X' });
  const b = AX.buildArchive('me', { exportedAt: 'X' });
  assert.deepEqual(AX.zipArchive(a.files), AX.zipArchive(b.files), 'zonder vaste mtime en volgorde is dit toeval');
});

test('de zip is door unzip te lezen', async () => {
  // Een zelfgeschreven zip die alleen zichzelf kan lezen is geen uitwisselformaat.
  const uit = AX.buildArchive('me');
  const zip = path.join(MEDIA, 'test.zip');
  fs.writeFileSync(zip, AX.zipArchive(uit.files));
  const { execFileSync } = await import('child_process');
  let lijst;
  try { lijst = execFileSync('unzip', ['-l', zip], { encoding: 'utf8' }); }
  catch (e) { if (e.code === 'ENOENT') return; throw e; }   // geen unzip op deze machine
  assert.match(lijst, /manifest\.json/);
  assert.match(lijst, /posts\/zwaar\.json/);
});

test('het manifest draagt de origin, want daar hangt het behoud van AP-ids aan', () => {
  const m = AX.buildArchive('me').manifest;
  assert.equal(m.origin, 'https://klonkt.test');
  assert.equal(m.formatVersion, 1);
  assert.equal(m.actor, 'https://klonkt.test/ap/users/me');
});

test('posts van een ANDERE site komen er niet in', () => {
  db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s2', 'buur', 'Buur', 'u1');
  db.prepare('INSERT INTO posts (id, site_id, slug, author_id, title, content, status) VALUES (?,?,?,?,?,?,?)')
    .run('vanbuur', 's2', 'vanbuur', 'u1', 'Niet van mij', '<p>x</p>', 'published');
  assert.equal(AX.buildArchive('me').files.has('posts/vanbuur.json'), false);
});

test.after(() => { try { fs.rmSync(MEDIA, { recursive: true, force: true }); } catch { /* niets */ } });
