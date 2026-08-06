// De importer (shaer-pmr), getoetst aan het formaat in docs/EXPORT-FORMAT.md.
//
// De zwaarste toets is de RONDGANG: exporteer de moeilijkste post die Klonkt kan
// maken, gooi hem weg, lees hem terug, en kijk of er nog hetzelfde staat. Een
// exporter en een importer die elk apart kloppen maar niet op elkaar aansluiten
// zijn samen niets waard.
//
// Run: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'klonkt-imp-'));
process.env.MEDIA_PATH = MEDIA;

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AX = await import('../src/services/ArchiveExportService.js');
const AI = await import('../src/services/ArchiveImportService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@test', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)').run('s1', 'me', 'Mijn site', 'u1');

fs.mkdirSync(path.join(MEDIA, '2026'), { recursive: true });
const PLAATJE = Buffer.from('bytes-van-de-cover');
fs.writeFileSync(path.join(MEDIA, '2026', 'cover.jpg'), PLAATJE);

db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, excerpt, status, published_at,
            created_at, updated_at, content_warning, nsfw, paid, paid_min_cents, quote_uri, quote_actor,
            poll_json, language, tags, pinned, view_count)
            VALUES ('zwaar','s1','zware-post','u1','Een zware post',
            '<p>body</p><img src="/media/2026/cover.jpg" alt="cover">','de teaser','published',
            '2026-08-01 10:00:00','2026-08-01 10:00:00','2026-08-01 12:00:00','spoiler',1,1,500,
            'https://mstdn.social/users/x/statuses/1','https://mstdn.social/users/x',
            '{"multiple":false,"options":[{"name":"ja"},{"name":"nee"}],"endTime":"2026-08-09T10:00:00Z"}',
            'nl','muziek, code',1,42)`).run();
db.prepare(`INSERT INTO ap_interactions (kind, post_id, object_uri, actor_uri, actor_name, actor_handle, content, published, created_at)
            VALUES ('reply','zwaar',?,?,'Anna','@anna@mstdn.social','<p>hoi</p>','2026-08-02T10:00:00Z','2026-08-02 10:00:00')`)
  .run('https://mstdn.social/users/anna/statuses/9', 'https://mstdn.social/users/anna');

const ARCHIEF = AX.buildArchive('me', { exportedAt: 'X' });
const leeg = () => {
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM ap_interactions').run();
  try { fs.rmSync(path.join(MEDIA, '2026'), { recursive: true, force: true }); } catch { /* niets */ }
};

test('de rondgang: wat eruit ging komt er hetzelfde weer in', () => {
  leeg();
  const r = AI.importArchive(ARCHIEF.files, { slug: 'me' });
  assert.equal(r.posts, 1);
  assert.equal(r.idsBehouden, true, 'zelfde origin, dus de AP-ids blijven');

  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get('zwaar');
  assert.ok(p, 'het post-id is behouden -- daar wijzen de boosts elders naar');
  assert.equal(p.title, 'Een zware post');
  assert.equal(p.slug, 'zware-post');
  assert.match(p.content, /<p>body<\/p>/);
  assert.equal(p.excerpt, 'de teaser');
  assert.equal(p.content_warning, 'spoiler');
  assert.equal(p.nsfw, 1);
  assert.equal(p.paid, 1);
  assert.equal(p.paid_min_cents, 500);
  assert.equal(p.quote_uri, 'https://mstdn.social/users/x/statuses/1');
  assert.equal(p.language, 'nl');
  assert.equal(p.tags, 'muziek, code');
  assert.equal(p.pinned, 1);
  assert.equal(p.view_count, 42);
  assert.deepEqual(JSON.parse(p.poll_json).options.map((o) => o.name), ['ja', 'nee']);
});

test('en de media staan terug op hun oude plek, want de content wijst daarheen', () => {
  const op = path.join(MEDIA, '2026', 'cover.jpg');
  assert.ok(fs.existsSync(op), 'anders is de <img> in de body een dode verwijzing');
  assert.deepEqual(fs.readFileSync(op), PLAATJE);
});

test('de antwoorden komen terug als archief', () => {
  const r = db.prepare("SELECT * FROM ap_interactions WHERE post_id = 'zwaar'").all();
  assert.equal(r.length, 1);
  assert.equal(r[0].actor_name, 'Anna');
  assert.equal(r[0].object_uri, 'https://mstdn.social/users/anna/statuses/9');
});

test('twee keer importeren levert geen dubbele posts op', () => {
  const voor = db.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
  const r = AI.importArchive(ARCHIEF.files, { slug: 'me' });
  assert.equal(r.overgeslagen, 1, 'de bestaande post wordt overgeslagen, niet overschreven');
  assert.equal(r.posts, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, voor);
});

test('overschrijven gebeurt alleen als je erom vraagt', () => {
  db.prepare("UPDATE posts SET title = 'handmatig gewijzigd' WHERE id = 'zwaar'").run();
  AI.importArchive(ARCHIEF.files, { slug: 'me' });
  assert.equal(db.prepare("SELECT title FROM posts WHERE id = 'zwaar'").get().title, 'handmatig gewijzigd',
    'zonder --overwrite blijft wat er staat staan');
  const r = AI.importArchive(ARCHIEF.files, { slug: 'me', overwrite: true });
  assert.equal(r.overschreven, 1);
  assert.equal(db.prepare("SELECT title FROM posts WHERE id = 'zwaar'").get().title, 'Een zware post');
});

test('een droogloop schrijft niets', () => {
  leeg();
  const r = AI.importArchive(ARCHIEF.files, { slug: 'me', dryRun: true });
  assert.equal(r.posts, 1, 'hij vertelt wel wat er zou gebeuren');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0);
  assert.equal(fs.existsSync(path.join(MEDIA, '2026', 'cover.jpg')), false);
});

test('een nieuwere formaatversie wordt in zijn GEHEEL geweigerd', () => {
  // Niet half lezen: een half begrepen herstel ziet eruit alsof het gelukt is.
  const files = new Map(ARCHIEF.files);
  const m = JSON.parse(files.get('manifest.json').toString());
  m.formatVersion = 99;
  files.set('manifest.json', Buffer.from(JSON.stringify(m)));
  assert.throws(() => AI.importArchive(files, { slug: 'me' }), /nieuwer dan deze Klonkt kent/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 0, 'en er is niets geschreven');
});

test('een andere origin levert NIEUWE ids op, met een waarschuwing', () => {
  // Oude ids houden op een ander domein zou objecten publiceren onder een id dat
  // je niet beheert -- andere servers halen dat daar op, en het is bovendien een
  // vervalsingsoppervlak.
  leeg();
  const files = new Map(ARCHIEF.files);
  const m = JSON.parse(files.get('manifest.json').toString());
  m.origin = 'https://ergens-anders.test';
  files.set('manifest.json', Buffer.from(JSON.stringify(m)));
  const r = AI.importArchive(files, { slug: 'me' });
  assert.equal(r.idsBehouden, false);
  assert.match(r.waarschuwingen.join(' '), /origin verschilt/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE id = 'zwaar'").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts').get().n, 1, 'wel geimporteerd, met een nieuw id');
});

test('ontbrekende media worden geteld en gemeld', () => {
  leeg();
  const files = new Map(ARCHIEF.files);
  const pad = [...files.keys()].find((k) => k.startsWith('posts/'));
  const o = JSON.parse(files.get(pad).toString());
  o.attachment = [{ type: 'Image', mediaType: 'image/jpeg', url: 'https://oud.test/media/weg.jpg', 'shaer:availability': 'missing', 'shaer:originalUrl': 'https://oud.test/media/weg.jpg' }];
  files.set(pad, Buffer.from(JSON.stringify(o)));
  const r = AI.importArchive(files, { slug: 'me' });
  assert.equal(r.mediaMissing, 1);
  assert.equal(r.gemist[0].url, 'https://oud.test/media/weg.jpg');
});

test('een archief dat zijn eigen bestand mist wordt apart gemeld', () => {
  // 'included' met een ontbrekend bestand is een KAPOT archief, geen verdwenen
  // media. Die twee op een hoop gooien verbergt een echt probleem.
  leeg();
  const files = new Map(ARCHIEF.files);
  for (const k of [...files.keys()]) if (k.startsWith('media/')) files.delete(k);
  const r = AI.importArchive(files, { slug: 'me' });
  assert.equal(r.mediaMissing, 0);
  assert.match(r.waarschuwingen.join(' '), /dat er niet in zit/);
});

test('een bestand met een verkeerde checksum wordt niet weggeschreven', () => {
  leeg();
  const files = new Map(ARCHIEF.files);
  const k = [...files.keys()].find((x) => x.startsWith('media/'));
  files.set(k, Buffer.from('iets heel anders'));
  const r = AI.importArchive(files, { slug: 'me' });
  assert.match(r.waarschuwingen.join(' '), /checksum klopt niet/);
  assert.equal(fs.existsSync(path.join(MEDIA, '2026', 'cover.jpg')), false);
});

test('een antwoordenbundel zonder archiefmarkering wordt overgeslagen', () => {
  leeg();
  const files = new Map(ARCHIEF.files);
  const pad = [...files.keys()].find((k) => k.startsWith('replies/'));
  const c = JSON.parse(files.get(pad).toString());
  delete c['shaer:archive'];
  files.set(pad, Buffer.from(JSON.stringify(c)));
  const r = AI.importArchive(files, { slug: 'me' });
  assert.equal(r.replies, 0);
  assert.match(r.waarschuwingen.join(' '), /niet gemarkeerd als archief/);
});

test('een pad buiten de media-map wordt niet geschreven', () => {
  leeg();
  const files = new Map(ARCHIEF.files);
  const pad = [...files.keys()].find((k) => k.startsWith('posts/'));
  const o = JSON.parse(files.get(pad).toString());
  const mk = [...files.keys()].find((k) => k.startsWith('media/'));
  o.attachment = [{ type: 'Image', mediaType: 'image/jpeg', url: mk, 'shaer:availability': 'included', 'shaer:originalUrl': '/media/../../../tmp/klonkt-inbraak' }];
  files.set(pad, Buffer.from(JSON.stringify(o)));
  AI.importArchive(files, { slug: 'me' });
  assert.equal(fs.existsSync('/tmp/klonkt-inbraak'), false);
});

test('readable/ wordt nooit gelezen', () => {
  // Dat is de hele reden dat het afgeleid is: twee bronnen die allebei gelezen
  // worden gaan uiteenlopen.
  leeg();
  const files = new Map(ARCHIEF.files);
  for (const k of [...files.keys()]) if (k.startsWith('readable/')) files.set(k, Buffer.from('ONZIN'));
  const r = AI.importArchive(files, { slug: 'me' });
  assert.equal(r.posts, 1);
  assert.match(db.prepare("SELECT content FROM posts WHERE id = 'zwaar'").get().content, /<p>body<\/p>/);
});

test('de zip-lezer haalt hetzelfde eruit als de map-lezer', () => {
  const zip = path.join(MEDIA, 'rond.zip');
  fs.writeFileSync(zip, AX.zipArchive(ARCHIEF.files));
  const uit = AI.readArchive(zip);
  assert.deepEqual([...uit.keys()].sort(), [...ARCHIEF.files.keys()].sort());
  for (const k of uit.keys()) assert.deepEqual(uit.get(k), ARCHIEF.files.get(k), `${k} verschilt`);
});

test('een GECOMPRIMEERDE zip van elders wordt ook gelezen', async () => {
  // Onze eigen zip is store-only. Zou de lezer alleen dat aankunnen, dan is het
  // geen uitwisselformaat maar een privé-doosje.
  const zlib = await import('zlib');
  const inhoud = Buffer.from('{"formatVersion":1,"origin":"x"}');
  const naam = Buffer.from('manifest.json', 'utf8');
  const comp = zlib.deflateRawSync(inhoud);
  const crc = (() => {
    let c = -1;
    for (const b of inhoud) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
    return (c ^ -1) >>> 0;
  })();
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(inhoud.length, 22);
  lh.writeUInt16LE(naam.length, 26);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(inhoud.length, 24);
  ch.writeUInt16LE(naam.length, 28); ch.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + naam.length, 12); eocd.writeUInt32LE(30 + naam.length + comp.length, 16);
  const zip = path.join(MEDIA, 'deflate.zip');
  fs.writeFileSync(zip, Buffer.concat([lh, naam, comp, ch, naam, eocd]));
  assert.deepEqual(AI.readArchiveZip(fs.readFileSync(zip)).get('manifest.json'), inhoud);
});

test('een gehoste track overleeft de rondgang, met zijn bestand erbij', () => {
  leeg();
  db.prepare('DELETE FROM audio_tracks').run();
  fs.mkdirSync(path.join(MEDIA, 'audio'), { recursive: true });
  const WAV = Buffer.from('nep-audio-bytes');
  fs.writeFileSync(path.join(MEDIA, 'audio', 't1.mp3'), WAV);
  db.prepare('INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES (?,?,?,?,?,?)')
    .run('m1', 's1', 't1.mp3', 'audio/mpeg', WAV.length, path.join(MEDIA, 'audio', 't1.mp3'));
  db.prepare(`INSERT INTO audio_tracks (id, site_id, title, artist, duration, media_id, credit, license)
              VALUES ('tr1','s1','Kanonnen','Robin',212,'m1','opname 2026','CC BY')`).run();
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, published_at)
              VALUES ('audio','s1','met-audio','u1','Met audio','<p>luister</p>[[track:tr1]]','published','2026-08-03 10:00:00')`).run();

  const arch = AX.buildArchive('me', { exportedAt: 'X' });
  db.prepare('DELETE FROM posts').run();
  db.prepare('DELETE FROM audio_tracks').run();
  db.prepare('DELETE FROM media').run();
  fs.rmSync(path.join(MEDIA, 'audio'), { recursive: true, force: true });

  AI.importArchive(arch.files, { slug: 'me' });
  const t = db.prepare("SELECT * FROM audio_tracks WHERE id = 'tr1'").get();
  assert.ok(t, '[[track:tr1]] in de content valt anders op niets terug');
  assert.equal(t.title, 'Kanonnen');
  assert.equal(t.license, 'CC BY');
  const m = db.prepare('SELECT * FROM media WHERE id = ?').get(t.media_id);
  assert.ok(m && fs.existsSync(m.storage_path), 'en het bestand staat er weer');
  assert.deepEqual(fs.readFileSync(m.storage_path), WAV);
});

test('een vroegtijdig gesloten poll blijft gesloten', () => {
  // Gevonden bij de rondgang op echte beta-data: poll_json.closed viel weg, dus
  // een poll die je met een einddatum in de TOEKOMST had gesloten stond na een
  // herstel weer open. AS2 kent hiervoor `closed` op een Question.
  leeg();
  db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, status, published_at, poll_json)
              VALUES ('dicht','s1','dichte-poll','u1','Dicht','<p>x</p>','published','2026-08-04 10:00:00',
              '{"multiple":false,"options":[{"name":"a"},{"name":"b"}],"endTime":"2030-01-01T00:00:00Z","closed":true}')`).run();
  const arch = AX.buildArchive('me', { exportedAt: 'X' });
  assert.equal(JSON.parse(arch.files.get('posts/dicht.json').toString()).closed, true);
  db.prepare('DELETE FROM posts').run();
  AI.importArchive(arch.files, { slug: 'me' });
  const d = JSON.parse(db.prepare("SELECT poll_json FROM posts WHERE id = 'dicht'").get().poll_json);
  assert.equal(d.closed, true, 'anders staat een gesloten stemming na een herstel weer open');
  assert.equal(d.endTime, '2030-01-01T00:00:00Z');
});

test('zonder manifest is het geen archief', () => {
  const files = new Map(ARCHIEF.files);
  files.delete('manifest.json');
  assert.throws(() => AI.importArchive(files, { slug: 'me' }), /geen manifest/);
});

test.after(() => { try { fs.rmSync(MEDIA, { recursive: true, force: true }); } catch { /* niets */ } });
