// De site als Funkwhale-Library, skelet (shaer-0nh).
//
// AANLEIDING, gemeten op 13-8 tegen open.audio: onze vier tracks waren daar
// binnengehaald langs de AP-weg -- met ONZE track-id's als fid, en met een
// artist_credit dat Funkwhale zelf uit onze attributedTo had afgeleid. Maar
// `uploads` was leeg en `is_playable` false. Bij hen hangt een upload aan een
// library; zonder die bak blijft een track een naam zonder geluid. Het
// audiobestand zelf is gewoon anoniem op te halen -- ze hadden het niet
// geprobeerd.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

const BASE = 'https://ons.test';
db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, description, owner_id) VALUES (?,?,?,?,?)')
  .run('s1', 'band', 'De Band', 'Onze plaatjes', 'u1');
const site = db.prepare("SELECT * FROM sites WHERE id = 's1'").get();

const insM = db.prepare('INSERT INTO media (id, site_id, filename, storage_path, mime_type, size) VALUES (?,?,?,?,?,?)');
const insT = db.prepare('INSERT INTO audio_tracks (id, site_id, title, duration, media_id, fedi_open) VALUES (?,?,?,?,?,?)');
insM.run('m1', 's1', 'open.mp3', 'a/open.mp3', 'audio/mpeg', 4210688);
insM.run('m2', 's1', 'dicht.mp3', 'a/dicht.mp3', 'audio/mpeg', 999);
insT.run('t1', 's1', 'Het open nummer', 203, 'm1', 1);
insT.run('t2', 's1', 'Achter de poort', 100, 'm2', 0);

const LIB = `${BASE}/ap/users/band/library`;

test('de bibliotheek heeft de vorm die hun docs voorschrijven', () => {
  const lib = AP.buildLibrary(BASE, site, AP.siteOpenTracks('s1'));
  assert.equal(lib.type, 'Library', 'niet OrderedCollection -- daar zoeken ze op');
  assert.equal(lib.id, LIB);
  assert.equal(lib.name, 'De Band');
  assert.equal(lib.attributedTo, `${BASE}/ap/users/band`);
  assert.equal(lib.followers, `${LIB}/followers`, 'vereist volgens hun docs');
  assert.equal(lib.first, `${LIB}?page=1`);
  assert.equal(lib.last, `${LIB}?page=1`);
  assert.equal(lib.totalItems, 1);
  assert.equal(lib.summary, 'Onze plaatjes');
});

test('een gesloten track hoort er NIET in -- dicht is dicht', () => {
  // De bibliotheek is openbaar; dat kan alleen als er niets in zit dat het
  // niet is. Zou een gated track hier binnenglippen, dan zou de openbaarheid
  // van de bak zijn poort overrulen.
  const lib = AP.buildLibrary(BASE, site, AP.siteOpenTracks('s1'));
  assert.deepEqual(lib.orderedItems.map((a) => a.name), ['Het open nummer']);
});

test('elke Audio wijst naar de bibliotheek', () => {
  // Dit is het veld waar het om begonnen was: het haakje waar een upload aan komt.
  const lib = AP.buildLibrary(BASE, site, AP.siteOpenTracks('s1'));
  for (const a of lib.orderedItems) assert.equal(a.library, LIB);
  // Ook als de track ergens anders vandaan komt -- de losse ophaal, de
  // trackcollectie, de playlist. Anders hangt het er maar op een plek.
  const los = AP.buildTrackAudio(BASE, site, AP.openTrack('s1', 't1'), { standalone: true });
  assert.equal(los.library, LIB);
});

test('de term is gedeclareerd, anders laat een strikte lezer hem vallen', async () => {
  const core = await import('../src/services/ap-core.js');
  const term = core.AP_CONTEXT.find((x) => x && typeof x === 'object' && x.library);
  assert.ok(term, 'library staat in de context');
  assert.equal(term.library['@id'], 'fw:library');
  assert.equal(term.library['@type'], '@id', 'het is een URI, geen tekst');
  assert.equal(term.Library, 'fw:Library');
  assert.equal(term.fw, 'https://funkwhale.audio/ns#');
});
