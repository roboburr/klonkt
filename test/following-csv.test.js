// Wie je volgt gaat mee bij een verhuizing.
//
// Dit ontbrak: de exporter dekte posts, tracks en antwoorden, maar niet je
// relaties. De Move vertelt je VOLGERS waar je heen ging; niets vertelde JOU wie
// jij volgde. Die lijst stond alleen in de database die je achterlaat.
//
// Kolomvorm van Mastodon, met een vijfde kolom van ons erachter, zodat de lijst
// beide kanten op werkt. Een uitwisselformaat dat alleen met zichzelf praat is
// geen uitwisselformaat.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{
  const stil = console.log;
  console.log = () => {};
  try { dbMod.initializeDatabase(); } finally { console.log = stil; }
}

const { followingCsv, parseFollowingCsv } = await import('../src/services/ArchiveExportService.js');
const { importFollowing } = await import('../src/services/ArchiveImportService.js');

const volg = db.prepare(`INSERT INTO ap_following (slug, actor_uri, handle, status, auto_boost)
                         VALUES (?,?,?,?,?)`);

beforeEach(() => {
  db.prepare('DELETE FROM ap_following').run();
});

test('de CSV heeft de Mastodon-koppen, met Featured erachter', () => {
  volg.run('me', 'https://a.example/ap/users/jason', '@jason@a.example', 'accepted', 1);
  const csv = followingCsv('me');
  const [kop, eerste] = csv.trim().split('\n');
  assert.equal(kop, 'Account address,Show boosts,Notify on new posts,Languages,Featured');
  // Zonder de leidende @, want zo schrijft Mastodon het adres.
  assert.equal(eerste, 'jason@a.example,,,,true');
});

test('een openstaand verzoek gaat NIET mee', () => {
  volg.run('me', 'https://a.example/ap/users/wacht', '@wacht@a.example', 'pending', 0);
  volg.run('me', 'https://a.example/ap/users/ja', '@ja@a.example', 'accepted', 0);
  const regels = followingCsv('me').trim().split('\n').slice(1);
  assert.equal(regels.length, 1, 'een verzoek dat iemand bewust liet liggen mag niet opnieuw verstuurd worden');
  assert.match(regels[0], /^ja@a\.example/);
});

test('zonder handle valt hij terug op de actor-URI', () => {
  volg.run('me', 'https://a.example/ap/users/naamloos', null, 'accepted', 0);
  assert.match(followingCsv('me'), /https:\/\/a\.example\/ap\/users\/naamloos/);
});

test('een lege lijst levert geen bestand op', () => {
  assert.equal(followingCsv('me'), null);
});

test('een export leest zichzelf terug', () => {
  volg.run('me', 'https://a.example/ap/users/a', '@a@a.example', 'accepted', 1);
  volg.run('me', 'https://b.example/ap/users/b', '@b@b.example', 'accepted', 0);
  const terug = parseFollowingCsv(followingCsv('me'));
  assert.deepEqual(terug, [
    { address: 'a@a.example', featured: true },
    { address: 'b@b.example', featured: false },
  ]);
});

test('een bestand uit Mastodon werkt, ook zonder onze vijfde kolom', () => {
  const uit = parseFollowingCsv(
    'Account address,Show boosts,Notify on new posts,Languages\n'
    + 'iemand@mastodon.social,true,false,\n',
  );
  // Hun "Show boosts" staat op true, en dat mag hier NIET als uitgelicht landen.
  assert.deepEqual(uit, [{ address: 'iemand@mastodon.social', featured: false }]);
});

test('een kale lijst adressen werkt ook, zonder kopregel', () => {
  const uit = parseFollowingCsv('@een@a.example\ntwee@b.example\n');
  assert.deepEqual(uit.map((r) => r.address), ['een@a.example', 'twee@b.example']);
});

test('een geciteerd veld met een komma erin blijft heel', () => {
  const uit = parseFollowingCsv('Account address,Show boosts\n"raar,naam@a.example",true\n');
  assert.equal(uit[0].address, 'raar,naam@a.example');
});

test('importFollowing volgt elke regel, met de boost-stand mee', async () => {
  const gezien = [];
  const r = await importFollowing({ slug: 'me' },
    'Account address,Show boosts,Notify on new posts,Languages,Featured\n'
    + 'a@a.example,,,,true\n'
    + 'b@b.example,,,,false\n',
    { followFn: async (site, adres, boost) => { gezien.push([adres, boost]); return true; } });

  assert.deepEqual(gezien, [['a@a.example', true], ['b@b.example', false]],
    'de uitgelicht-stand moet als derde argument mee de Follow in');
  assert.equal(r.gevolgd, 2);
  assert.equal(r.mislukt.length, 0);
});

test('jezelf volgen wordt overgeslagen', async () => {
  const r = await importFollowing({ slug: 'me' },
    'Account address\nme@eigen.example\nander@a.example\n',
    { followFn: async () => true });
  assert.equal(r.overgeslagen, 1);
  assert.equal(r.gevolgd, 1);
});

test('een mislukte follow stopt de rest niet, en wordt gemeld', async () => {
  const r = await importFollowing({ slug: 'me' },
    'Account address\neen@a.example\nkapot@b.example\ndrie@c.example\n',
    { followFn: async (s, adres) => { if (adres.startsWith('kapot')) throw new Error('onbereikbaar'); return true; } });

  assert.equal(r.gevolgd, 2, 'de derde moet nog geprobeerd zijn na de tweede');
  assert.deepEqual(r.mislukt, [{ adres: 'kapot@b.example', reden: 'onbereikbaar' }]);
});

test('zonder followFn gebeurt er niets, en dat zegt hij ook', async () => {
  const r = await importFollowing({ slug: 'me' }, 'Account address\na@a.example\n', {});
  assert.equal(r.error, 'no_follow_fn');
  assert.equal(r.gevolgd, 0);
});

// De koppeling zelf. De losse functies hierboven kunnen prima werken terwijl het
// archief de CSV nooit ziet, en dat is precies het soort stil gat waar een
// verhuizing op strandt: alles groen, en je volglijst blijft achter.
test('buildArchive stopt following.csv er echt in, met hash in het manifest', async () => {
  db.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'u1', 'u1@test', 'x', 'god');
  db.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'me', 'Mijn site', 'u1');
  volg.run('me', 'https://a.example/ap/users/jason', '@jason@a.example', 'accepted', 1);

  const { buildArchive } = await import('../src/services/ArchiveExportService.js');
  const r = buildArchive('me', { origin: 'https://oud.example' });

  assert.ok(r.files.has('following.csv'), 'het archief moet de volglijst dragen');
  assert.equal(r.counts.following, 1);
  assert.ok(r.manifest.files['following.csv'], 'en hij hoort in het manifest, anders telt hij niet mee bij de controle');
  assert.match(String(r.files.get('following.csv')), /jason@a\.example,,,,true/);
});
