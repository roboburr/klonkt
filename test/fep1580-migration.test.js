// FEP-1580: je objecten verhuizen mee met een Move.
//
// FEP-7628 verhuist je VOLGERS en zegt zelf dat de inhoud een ander probleem is.
// Dit is dat probleem. Twee rollen, en ze horen bij elkaar: de BRON geeft de
// nieuwe instantie zijn eigen kijkrechten, de DOELkant haalt op en publiceert
// een vertaaltabel zodat derden hun verwijzingen kunnen bijwerken.
//
// Het hele vertrouwen hangt aan één ding: `moved_to` staat er alleen als
// moveAccount() een terugverwijzing in alsoKnownAs zag. Dat is tweezijdig
// bewijs, en daarom is er geen tweede mechanisme (geen token, geen code) nodig.
// Deze tests leggen precies vast hoever die sleutel reikt, want een sleutel die
// te ver reikt geeft je hele geschiedenis aan de verkeerde.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://nieuw.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{
  const stil = console.log;
  console.log = () => {};
  try { dbMod.initializeDatabase(); } finally { console.log = stil; }
}
const AP = await import('../src/services/ActivityPubService.js');
const Mig = await import('../src/services/MigrationService.js');

const BRON = 'https://oud.example/ap/users/robo';
const IK = 'https://nieuw.example/ap/users/ik';

function site({ aliases = [], movedTo = null } = {}) {
  db.prepare('INSERT OR IGNORE INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run('u1', 'u1', 'u1@test', 'x', 'god');
  db.prepare('INSERT OR IGNORE INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
    .run('s1', 'ik', 'Mijn site', 'u1');
  db.prepare('UPDATE sites SET ap_aliases = ?, moved_to = ? WHERE slug = ?')
    .run(JSON.stringify(aliases), movedTo, 'ik');
  return db.prepare('SELECT * FROM sites WHERE slug = ?').get('ik');
}

async function stil(fn) {
  const w = console.warn; const l = console.log;
  console.warn = () => {}; console.log = () => {};
  try { return await fn(); } finally { console.warn = w; console.log = l; }
}

beforeEach(() => {
  for (const t of ['ap_migration', 'ap_moves', 'ap_blocks', 'posts', 'ap_followers', 'audio_tracks', 'media']) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* tabel bestaat niet in deze build */ }
  }
});

// ── BRONKANT: hoever reikt de sleutel ─────────────────────────────

test('isMoveTarget geldt alleen voor precies de actor waar we heen gingen', () => {
  site({ movedTo: BRON });
  assert.equal(AP.isMoveTarget('ik', BRON), true);
  assert.equal(AP.isMoveTarget('ik', BRON + '2'), false, 'een prefix is geen match');
  assert.equal(AP.isMoveTarget('ik', 'https://oud.example/ap/users/iemand'), false, 'zelfde host is niet genoeg');
  assert.equal(AP.isMoveTarget('ik', ''), false);
  assert.equal(AP.isMoveTarget('ik', null), false);
});

test('zonder verhuizing opent de sleutel niets', () => {
  site({ movedTo: null });
  assert.equal(AP.isMoveTarget('ik', BRON), false);
  assert.equal(AP.outboxAudience('ik', { verifiedActor: BRON }), 'public');
});

test('de doelinstantie krijgt de fan-only geschiedenis te zien', () => {
  // Dit is de kern van de bronkant. Zonder deze tak haalt de nieuwe Klonkt
  // alleen je publieke berichten op en blijft de rest achter op een domein
  // dat je gaat opzeggen.
  site({ movedTo: BRON });
  assert.equal(AP.outboxAudience('ik', { verifiedActor: BRON }), 'friend');
  const post = { fan_only: 1 };
  assert.equal(AP.mayReadNote({ slug: 'ik' }, post, BRON), true);
  assert.equal(AP.mayReadNote({ slug: 'ik' }, post, 'https://elders.example/users/x'), false,
    'een vreemde blijft buiten, ook tijdens een verhuizing');
});

test('een geblokkeerde actor wint van de verhuizing', () => {
  // De volgorde in outboxAudience is niet toevallig: een block is een gesloten
  // deur, en die gaat niet open omdat er toevallig een verhuizing loopt. Zou
  // iemand ooit moved_to naar een geblokkeerd account zetten, dan hoort de
  // blokkade te winnen en niet andersom.
  site({ movedTo: BRON });
  db.prepare("INSERT INTO ap_blocks (slug, target, kind) VALUES (?, ?, 'actor')").run('ik', BRON);
  assert.equal(AP.outboxAudience('ik', { verifiedActor: BRON }), 'blocked');
});

test('direct-berichten gaan nooit over de lijn, ook niet bij een verhuizing', () => {
  site({ movedTo: BRON });
  const dm = { ap_visibility: 'direct' };
  assert.equal(AP.mayReadNote({ slug: 'ik' }, dm, BRON), false,
    'een DM is aan iemand gericht; die migreer je niet via een GET');
});

test('de outbox adresseert een fan-only post NIET als publiek', () => {
  // Gevonden tijdens de end-to-end test van deze feature, maar het is een
  // bestaande fout die er los van staat: outboxSlice haalde fan_only en
  // ap_visibility niet op, dus buildNote zag post.fan_only === undefined en
  // zette to: as:Public op ALLES. De post werd wel alleen aan vrienden
  // geserveerd, maar met een publiek etiket erop, en dan mag een volger hem
  // publiek boosten.
  //
  // Deze test hangt hier omdat de migratie erop leunt: de doelkant beslist aan
  // de hand van dit adres of een bericht in de PUBLIEKE vertaaltabel mag.
  const s = site();
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, fan_only, published_at)
              VALUES ('pf', 's1', 'u1', 'fans', 'Fans', '<p>x</p>', 'published', 1, '2024-01-01T00:00:00Z')`).run();
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
              VALUES ('pp', 's1', 'u1', 'open', 'Open', '<p>y</p>', 'published', '2024-01-02T00:00:00Z')`).run();

  const { posts } = AP.outboxSlice('s1', { fanOnly: true, page: 1 });
  const rij = (id) => posts.find((p) => p.id === id);
  assert.ok(rij('pf'), 'de fan-only post hoort in de vrienden-outbox te zitten');
  assert.equal(rij('pf').fan_only, 1, 'en zijn zichtbaarheid moet MEE uit de database komen');

  const fan = AP.buildNote('https://nieuw.example', s, rij('pf'));
  assert.equal(AP.noteVisibility(fan), 'followers',
    'een fan-only post die as:Public heet mag een volger publiek boosten');
  const open = AP.buildNote('https://nieuw.example', s, rij('pp'));
  assert.equal(AP.noteVisibility(open), 'public', 'en een gewone post blijft gewoon publiek');
});

// ── DOELKANT: de collecties ───────────────────────────────────────

test('de actor adverteert migration en moves, ook als er niets verhuisd is', () => {
  // De FEP wijst hier apart op: zonder deze twee is "een verhuizing zonder
  // objecten" niet te onderscheiden van "een server die dit niet kent".
  const doc = AP.buildActor('https://nieuw.example', site());
  assert.equal(doc.migration, `${IK}/migration`);
  assert.equal(doc.moves, `${IK}/moves`);
});

test('een lege migration-collectie is geldig en zegt dat hij klaar is', () => {
  const coll = Mig.buildMigration('https://nieuw.example', site());
  assert.equal(coll.type, 'OrderedCollection');
  assert.equal(coll.totalItems, 0);
  assert.equal(coll.migrationComplete, true, 'niets te doen is ook klaar; anders blijven derden pollen');
  assert.equal(coll.moves, `${IK}/moves`, 'de spec eist de verwijzing naar de moves-collectie');
});

test('de vertaaltabel mapt oud naar nieuw, nieuwste kopie eerst', () => {
  const s = site();
  Mig.recordMigrated('ik', { origin: `${BRON}/notes/1`, target: `${IK}/notes/a`, sourceActor: BRON });
  Mig.recordMigrated('ik', { origin: `${BRON}/notes/2`, target: `${IK}/notes/b`, sourceActor: BRON });
  const coll = Mig.buildMigration('https://nieuw.example', s);
  assert.equal(coll.totalItems, 2);
  const items = coll.orderedItems || coll.items;
  assert.equal(items[0].origin, `${BRON}/notes/2`, 'omgekeerd chronologisch op aanmaakmoment HIER');
  assert.equal(items[0].type, 'Move');
  assert.equal(items[0].target, `${IK}/notes/b`);
});

test('niet-publieke items staan niet in de publieke vertaaltabel', () => {
  // Een lijst met de URIs van je fan-only posts is een lek, ook zonder inhoud:
  // hij verraadt hoeveel er zijn en wanneer ze kwamen.
  const s = site();
  Mig.recordMigrated('ik', { origin: `${BRON}/notes/pub`, target: `${IK}/notes/a`, isPublic: true });
  Mig.recordMigrated('ik', { origin: `${BRON}/notes/geheim`, target: `${IK}/notes/b`, isPublic: false });
  assert.equal(Mig.buildMigration('https://nieuw.example', s).totalItems, 1);
  assert.equal(Mig.buildMigration('https://nieuw.example', s, { alles: true }).totalItems, 2);
  const publiek = JSON.stringify(Mig.buildMigration('https://nieuw.example', s));
  assert.ok(!publiek.includes('geheim'), 'de URI zelf mag er ook niet in staan');
});

test('dezelfde origin twee keer levert een rij, geen dubbele', () => {
  const s = site();
  Mig.recordMigrated('ik', { origin: `${BRON}/notes/1`, target: `${IK}/notes/a` });
  Mig.recordMigrated('ik', { origin: `${BRON}/notes/1`, target: `${IK}/notes/a` });
  assert.equal(Mig.buildMigration('https://nieuw.example', s).totalItems, 1,
    'een tweede ingest-ronde mag de tabel niet verdubbelen');
});

test('de moves-collectie bewaart het bron-actordocument erbij', () => {
  // De spec: sluit de bron-actor in, zodat een lezer de herkomst kan nakijken
  // ook als de bron onbereikbaar is. Dat is precies het geval waarvoor dit
  // bestaat, dus een verwijzing naar de bron zou hier niets waard zijn.
  const s = site();
  const actorDoc = { id: BRON, type: 'Person', publicKey: { id: `${BRON}#main-key`, owner: BRON, publicKeyPem: 'x' } };
  Mig.recordMove('ik', { moveId: `${BRON}#move`, sourceActor: BRON, targetActor: IK, activity: { type: 'Move' }, actorDoc });
  const coll = Mig.buildMoves('https://nieuw.example', s);
  assert.equal(coll.totalItems, 1);
  assert.equal(coll.orderedItems[0].origin, BRON);
  assert.equal(coll.orderedItems[0].target, IK);
  assert.equal(coll.orderedItems[0].actor.publicKey.publicKeyPem, 'x', 'ingesloten, niet als verwijzing');
});

test('er staat GEEN handtekening onder de moves-collectie', () => {
  // Bewuste keuze zolang shaer-j1v0 (FEP-8b32) open staat. Een leeg of nep
  // proof-veld is erger dan geen veld: een derde die het controleert wordt dan
  // misleid. Deze test valt om zodra we 8b32 bouwen, en dat is de bedoeling.
  const s = site();
  Mig.recordMove('ik', { moveId: `${BRON}#move`, sourceActor: BRON, targetActor: IK, activity: {} });
  const coll = Mig.buildMoves('https://nieuw.example', s);
  assert.equal(coll.proof, undefined,
    'liever eerlijk niets dan een proof-veld dat niets bewijst (zie shaer-j1v0)');
});

// ── DOELKANT: de ingest ───────────────────────────────────────────

// Een nep-bron, zodat dit zonder netwerk draait.
function bronnetje({ movedTo = IK, items = [], blocked = null } = {}) {
  const actor = {
    id: BRON, type: 'Person', movedTo,
    outbox: `${BRON}/outbox`,
    ...(blocked ? { blocked: `${BRON}/blocked` } : {}),
  };
  const kaart = new Map([
    [BRON, actor],
    [`${BRON}/outbox`, { type: 'OrderedCollection', orderedItems: items }],
    ...(blocked ? [[`${BRON}/blocked`, { type: 'OrderedCollection', orderedItems: blocked }]] : []),
  ]);
  // noteVisibility erbij: zonder deze telt alles als niet-publiek (fail-closed),
  // en dan zou de test op de publieke vertaaltabel groen zijn om de verkeerde reden.
  return {
    getJson: async (_slug, url) => kaart.get(url) || null,
    noteId: (b, id) => `${b}/ap/notes/${id}`,
    noteVisibility: AP.noteVisibility,
  };
}

function note(id, extra = {}) {
  return {
    type: 'Create',
    object: {
      id, type: 'Note', attributedTo: BRON, content: '<p>hallo</p>',
      published: '2023-05-04T10:00:00Z', to: ['https://www.w3.org/ns/activitystreams#Public'],
      ...extra,
    },
  };
}

test('de ingest weigert als de bron niet naar ONS wijst', async () => {
  const s = site({ aliases: [BRON] });
  const r = await stil(() => Mig.ingestFromSource(s, { deps: bronnetje({ movedTo: 'https://iemandanders.example/users/x' }) }));
  assert.equal(r.error, 'not_moved_here',
    'anders kon je de geschiedenis opeisen van iedereen die toevallig verhuisde');
});

test('de ingest weigert zonder onze eigen terugverwijzing', async () => {
  // Eén kant is een bewering, twee kanten is een afspraak. Dit is de aanval:
  // iemand laat je een bron-adres invullen, die bron roept movedTo naar ons,
  // en zonder deze controle trekken we andermans geschiedenis binnen als de
  // onze. De bron wordt hier EXPLICIET meegegeven, want anders strandt hij al
  // eerder op no_source en test je niets.
  const s = site({ aliases: ['https://ietsanders.example/users/ik'] });
  const r = await stil(() => Mig.ingestFromSource(s, { sourceUri: BRON, deps: bronnetje({}) }));
  assert.equal(r.error, 'no_backreference');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 0, 'en er is niets binnengekomen');
});

test('zonder alias en zonder opgegeven bron valt er niets op te halen', async () => {
  const s = site({ aliases: [] });
  const r = await stil(() => Mig.ingestFromSource(s, { deps: bronnetje({}) }));
  assert.equal(r.error, 'no_source');
});

test('de ingest haalt de berichten op en houdt de oorspronkelijke datum', async () => {
  const s = site({ aliases: [BRON] });
  const deps = bronnetje({ items: [note(`${BRON}/notes/1`), note(`${BRON}/notes/2`)] });
  const r = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r.posts, 2);
  const rijen = db.prepare('SELECT slug, published_at, origin_server FROM posts WHERE site_id = ? ORDER BY slug').all('s1');
  assert.equal(rijen.length, 2);
  assert.equal(rijen[0].published_at, '2023-05-04T10:00:00Z',
    'een verhuisd bericht is niet vandaag geschreven; de spec eist behoud van de timestamps');
  assert.equal(rijen[0].origin_server, 'migrated');
  // en de vertaaltabel is gevuld, want dat is het punt van de hele operatie
  assert.equal(Mig.buildMigration('https://nieuw.example', s).totalItems, 2);
});

test('de ingest zet de vlag open tijdens en dicht na afloop', async () => {
  const s = site({ aliases: [BRON] });
  await stil(() => Mig.ingestFromSource(s, { deps: bronnetje({ items: [note(`${BRON}/notes/1`)] }) }));
  assert.equal(Mig.migrationComplete('ik'), true, 'pas na afloop mag een derde stoppen met kijken');
});

test('een tweede ronde slaat over wat er al is', async () => {
  const s = site({ aliases: [BRON] });
  const deps = bronnetje({ items: [note(`${BRON}/notes/1`)] });
  await stil(() => Mig.ingestFromSource(s, { deps }));
  const r = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r.posts, 0);
  assert.equal(r.overgeslagen, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 1, 'geen dubbele berichten');
});

test('blokkades komen eerst binnen', async () => {
  // De spec zet dit expliciet vooraan: blokkades bepalen wie de rest te zien
  // krijgt. Andersom importeer je je hele geschiedenis zichtbaar voor precies
  // degene die je buiten wilde houden.
  const s = site({ aliases: [BRON] });
  const deps = bronnetje({ items: [note(`${BRON}/notes/1`)], blocked: ['https://elders.example/users/pest'] });
  const r = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r.blocks, 1);
  const b = db.prepare("SELECT target FROM ap_blocks WHERE slug = 'ik' AND kind = 'actor'").all();
  assert.deepEqual(b.map((x) => x.target), ['https://elders.example/users/pest']);
});

test('de ingest neemt geen antwoorden en niets van een ander mee', async () => {
  const s = site({ aliases: [BRON] });
  const deps = bronnetje({
    items: [
      note(`${BRON}/notes/1`),
      note(`${BRON}/notes/2`, { inReplyTo: 'https://elders.example/notes/9' }),
      note(`${BRON}/notes/3`, { attributedTo: 'https://elders.example/users/ander' }),
    ],
  });
  const r = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r.posts, 1, 'alleen je eigen toplevel-berichten verhuizen mee');
});

test('de muziekbibliotheek komt mee, ook wat niet fedi_open is', async () => {
  // Losse nummers staan NIET in de outbox: die hangen aan de tracks-collectie
  // waar de actor via AS2 `streams` naar wijst. Zonder deze tak verhuist een
  // muzieksite zijn berichten en laat hij zijn bibliotheek achter, en dat is
  // precies wat er op soundfabrics.nl gebeurde.
  const s = site({ aliases: [BRON] });
  const AUDIO = `${BRON}/audio/x.mp3`;
  const bytes = Buffer.from('ID3-nep-geluid');
  const kaart = new Map([
    [BRON, {
      id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox`,
      streams: [`${BRON}/tracks`, `${BRON}/playlists`],
    }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', orderedItems: [] }],
    [`${BRON}/tracks`, {
      type: 'OrderedCollection',
      orderedItems: [{
        id: `${BRON}/tracks/t1`, type: 'Audio', name: 'Gesloten nummer', artist: 'Robo',
        url: [{ type: 'Link', href: AUDIO, mediaType: 'audio/mpeg' }],
      }],
    }],
  ]);
  const geschreven = new Map();
  let getekend = false;
  const r = await stil(() => Mig.ingestFromSource(s, {
    deps: {
      getJson: async (_slug, url) => kaart.get(url) || null,
      noteId: (b, id) => `${b}/ap/notes/${id}`,
      noteVisibility: AP.noteVisibility,
      audioRoot: '/nep/audio',
      // De handtekening is hier geen detail: de audio-route van de bron weigert
      // een kale fetch, want die kan niet zien dat wij de doel-actor zijn.
      signHeaders: () => { getekend = true; return { Signature: 'nep' }; },
      safeFetch: async (url, opts) => {
        assert.equal(url, AUDIO);
        assert.ok(opts.headers && opts.headers.Signature, 'de bytes worden ONDERTEKEND opgehaald');
        return { ok: true, arrayBuffer: async () => bytes, headers: { get: () => 'audio/mpeg' } };
      },
      fs: { mkdirSync() {}, writeFileSync: (p, b) => geschreven.set(p, b) },
      path,
    },
  }));
  assert.equal(r.tracksBinnen, 1);
  assert.equal(r.tracksMislukt, 0);
  assert.ok(getekend);
  assert.equal(geschreven.size, 1, 'het bestand wordt echt weggeschreven');
  const [pad] = [...geschreven.keys()];
  assert.ok(pad.startsWith('/nep/audio/'), 'audio hoort in AUDIO_ROOT, niet in de mediamap');
  assert.ok(!pad.slice('/nep/audio/'.length).includes('/'), 'en er direct in, want de speler zoekt op bestandsnaam');
  const t = db.prepare('SELECT title, artist FROM audio_tracks').get();
  assert.equal(t.title, 'Gesloten nummer');
});

test('een nummer waarvan de bytes niet komen levert GEEN track op', async () => {
  // Dezelfde regel als bij de zip. Een nummer dat in de lijst staat en 404't is
  // erger dan een nummer dat ontbreekt.
  const s = site({ aliases: [BRON] });
  const kaart = new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox`, streams: [`${BRON}/tracks`] }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', orderedItems: [] }],
    [`${BRON}/tracks`, {
      type: 'OrderedCollection',
      orderedItems: [{ id: `${BRON}/tracks/t1`, type: 'Audio', name: 'Weg', url: `${BRON}/audio/weg.mp3` }],
    }],
  ]);
  const r = await stil(() => Mig.ingestFromSource(s, {
    deps: {
      getJson: async (_slug, url) => kaart.get(url) || null,
      noteId: (b, id) => `${b}/ap/notes/${id}`,
      noteVisibility: AP.noteVisibility,
      audioRoot: '/nep/audio',
      signHeaders: () => ({ Signature: 'nep' }),
      safeFetch: async () => ({ ok: false, status: 403 }),
      fs: { mkdirSync() {}, writeFileSync() { throw new Error('mag niet gebeuren'); } },
      path,
    },
  }));
  assert.equal(r.tracksBinnen, 0);
  assert.equal(r.tracksMislukt, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audio_tracks').get().n, 0);
});

test('een tweede ronde VULT AAN en slaat niet over', async () => {
  // De val die Robin bijna in liep: de eerste versie van de ingest onthield per
  // bron-URI "al gehad" en passeerde die daarna altijd. Kwam er later iets bij
  // (hoezen, duur, playlists), dan kon je opnieuw drukken zoveel je wilde en
  // gebeurde er niets. Opruimen hielp ook niet, want ap_migration hield de
  // blokkade in stand. Dus: aanvullen, niet overslaan.
  const s = site({ aliases: [BRON] });
  const AUDIO = `${BRON}/audio/x.mp3`;
  const HOES = `${BRON}/media/hoes.png`;
  const maakKaart = (metHoes) => new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox`, streams: [`${BRON}/tracks`] }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', orderedItems: [] }],
    [`${BRON}/tracks`, {
      type: 'OrderedCollection',
      orderedItems: [{
        id: `${BRON}/tracks/t1`, type: 'Audio', name: 'Nummer', summary: 'Robo', duration: 'PT212S',
        url: [{ type: 'Link', href: AUDIO, mediaType: 'audio/mpeg' }],
        ...(metHoes ? { icon: { type: 'Image', url: HOES } } : {}),
      }],
    }],
  ]);
  const gehaald = [];
  const deps = (metHoes) => ({
    getJson: async (_slug, url) => maakKaart(metHoes).get(url) || null,
    noteId: (b, id) => `${b}/ap/notes/${id}`,
    noteVisibility: AP.noteVisibility,
    audioRoot: '/nep/audio', mediaRoot: '/nep/media',
    signHeaders: () => ({ Signature: 'nep' }),
    safeFetch: async (url) => {
      gehaald.push(url);
      return { ok: true, arrayBuffer: async () => Buffer.from('x'), headers: { get: () => 'audio/mpeg' } };
    },
    fs: { mkdirSync() {}, writeFileSync() {} },
    path,
  });

  // Ronde 1: zonder hoes, zoals de eerste uitrol.
  const r1 = await stil(() => Mig.ingestFromSource(s, { deps: deps(false) }));
  assert.equal(r1.tracksBinnen, 1);
  const na1 = db.prepare('SELECT id, cover_url, duration FROM audio_tracks').get();
  assert.equal(na1.cover_url, null);
  assert.equal(na1.duration, 212, 'PT212S hoort 212 seconden te worden');

  // Ronde 2: nu MET hoes. Hij moet aanvullen, niet passeren en niet verdubbelen.
  const voor = gehaald.length;
  const r2 = await stil(() => Mig.ingestFromSource(s, { deps: deps(true) }));
  assert.equal(r2.tracksBinnen, 0, 'er komt niets nieuws bij');
  assert.equal(r2.tracksBijgewerkt, 1, 'maar het bestaande nummer wordt wel aangevuld');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audio_tracks').get().n, 1, 'geen dubbele');
  const na2 = db.prepare('SELECT id, cover_url FROM audio_tracks').get();
  assert.equal(na2.id, na1.id, 'dezelfde rij, niet een nieuwe');
  assert.ok(na2.cover_url, 'en de hoes is er nu wel');
  assert.ok(!gehaald.slice(voor).includes(AUDIO), 'het geluidsbestand wordt NIET opnieuw gedownload');

  // Ronde 3: alles compleet, dus er valt niets meer aan te vullen.
  const r3 = await stil(() => Mig.ingestFromSource(s, { deps: deps(true) }));
  assert.equal(r3.tracksBijgewerkt, 0);
  assert.equal(r3.overgeslagenTracks, 1);
});

test('de outbox-keten wordt gevolgd, ook als de kale collectie zelf items draagt', async () => {
  // Robins 18 van 35. Klonkts kale outbox draagt first EN een kopie van
  // pagina 1 (Pleroma eiste ooit een first, sindsdien staan ze er allebei).
  // De ingest zag items, sloeg first over, vond daarna geen next (dat veld
  // bestaat alleen op echte pagina's) en dacht klaar te zijn. Zonder een
  // waarschuwing, en dat was het ergste deel.
  const s = site({ aliases: [BRON] });
  const maak = (i) => note(`${BRON}/notes/n${i}`);
  const p1 = Array.from({ length: 20 }, (_, i) => maak(i + 1));
  const p2 = Array.from({ length: 8 }, (_, i) => maak(i + 21));
  const kaart = new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox` }],
    // de valstrik: totalItems, first, EN de eerste twintig inline
    [`${BRON}/outbox`, { type: 'OrderedCollection', totalItems: 28, first: `${BRON}/outbox?page=1`, orderedItems: p1 }],
    [`${BRON}/outbox?page=1`, { type: 'OrderedCollectionPage', next: `${BRON}/outbox?page=2`, orderedItems: p1 }],
    [`${BRON}/outbox?page=2`, { type: 'OrderedCollectionPage', orderedItems: p2 }],
  ]);
  const r = await stil(() => Mig.ingestFromSource(s, { deps: {
    getJson: async (_s, url) => kaart.get(url) || null,
    noteId: (b, id) => `${b}/ap/notes/${id}`,
    noteVisibility: AP.noteVisibility,
  } }));
  assert.equal(r.posts, 28, 'alle pagina\'s, niet alleen de kopie op de kale collectie');
});

test('een niet opgehaalde pagina wordt GEMELD, niet verzwegen', async () => {
  const s = site({ aliases: [BRON] });
  const p1 = Array.from({ length: 20 }, (_, i) => note(`${BRON}/notes/n${i + 1}`));
  const kaart = new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox` }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', totalItems: 28, first: `${BRON}/outbox?page=1` }],
    [`${BRON}/outbox?page=1`, { type: 'OrderedCollectionPage', next: `${BRON}/outbox?page=2`, orderedItems: p1 }],
    // pagina 2 antwoordt niet (rate limit, netwerkstoring, wat dan ook)
  ]);
  const r = await stil(() => Mig.ingestFromSource(s, { deps: {
    getJson: async (_s, url) => kaart.get(url) || null,
    noteId: (b, id) => `${b}/ap/notes/${id}`,
    noteVisibility: AP.noteVisibility,
  } }));
  assert.equal(r.posts, 20);
  assert.ok(r.waarschuwingen.some((w) => /28 items en er zijn er 20/.test(w)),
    'stil minder ophalen dan de bron meldt is hoe 18 van 35 wekenlang op klaar had gestaan');
});

test('een plaatje in de tekst wordt gedownload en de verwijzing wordt relatief', async () => {
  // Robins hotlinks. En de valkuil die de eerste versie half liet werken: de
  // regex stond als STRING in een template literal, \s werd een kale s, en
  // elke URL met een s erin (post-images!) knapte af. Vandaar de assert op de
  // VOLLEDIGE url, letter voor letter.
  const s = site({ aliases: [BRON] });
  const IMG = `${BRON.replace('/ap/users/robo', '')}/media/post-images/plaatje-strak.png`;
  const kaart = new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox` }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', totalItems: 1, first: `${BRON}/outbox?page=1` }],
    [`${BRON}/outbox?page=1`, { type: 'OrderedCollectionPage', orderedItems: [
      note(`${BRON}/notes/pi`, { content: `<p>kijk</p><a href="${IMG}"><img src="${IMG}"></a>` }),
    ] }],
  ]);
  const opgehaald = [];
  const geschreven = [];
  const r = await stil(() => Mig.ingestFromSource(s, { deps: {
    getJson: async (_s, url) => kaart.get(url) || null,
    noteId: (b, id) => `${b}/ap/notes/${id}`,
    noteVisibility: AP.noteVisibility,
    mediaRoot: '/nep/media', audioRoot: '/nep/audio',
    signHeaders: () => ({ Signature: 'nep' }),
    safeFetch: async (url) => { opgehaald.push(url); return { ok: true, arrayBuffer: async () => Buffer.from('png'), headers: { get: () => 'image/png' } }; },
    fs: { mkdirSync() {}, writeFileSync: (pad) => geschreven.push(pad), statSync() { throw new Error('ENOENT'); } },
    path,
  } }));
  assert.equal(r.posts, 1);
  assert.deepEqual(opgehaald, [IMG], 'de VOLLEDIGE url, niet een afgekapt stuk');
  assert.deepEqual(geschreven, ['/nep/media/post-images/plaatje-strak.png'], 'op het pad van de bron');
  const c = db.prepare("SELECT content FROM posts WHERE site_id = 's1'").get().content;
  assert.ok(c.includes('src="/media/post-images/plaatje-strak.png"'), `relatief herschreven, kreeg: ${c}`);
  assert.ok(!c.includes('oud.example'), 'en er hotlinkt niets meer naar de bron');
});

test('een bericht dat je zelf hebt verwijderd komt bij een tweede ronde terug', async () => {
  // Robin: "ik kan handmatig deze keer de posts verwijderen en opnieuw ophalen."
  // Met de eerste opzet kon dat niet: de mapping in ap_migration zei "al gehad"
  // en dan werd alles overgeslagen, hoe leeg je site ook was. Dezelfde val als
  // bij de nummers, en juist deze zou hij als eerste tegenkomen.
  const s = site({ aliases: [BRON] });
  const deps = bronnetje({ items: [note(`${BRON}/notes/1`), note(`${BRON}/notes/2`)] });

  const r1 = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r1.posts, 2);

  // Eentje weg, de mapping blijft staan.
  const weg = db.prepare('SELECT id FROM posts LIMIT 1').get().id;
  db.prepare('DELETE FROM posts WHERE id = ?').run(weg);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 1);

  const r2 = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r2.posts, 1, 'het verwijderde bericht hoort terug te komen');
  assert.equal(r2.opnieuw, 1, 'en het verslag zegt dat het opnieuw is opgehaald');
  assert.equal(r2.overgeslagen, 1, 'terwijl het bericht dat er nog stond met rust blijft');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM posts').get().n, 2, 'geen dubbele');
});

test('de [[track:]]-verwijzing in een bericht blijft naar een bestaand nummer wijzen', async () => {
  // Wat Robin op TikTik zag: het bericht toonde de shorthand zelf in plaats van
  // een speler. Zijn posts kwamen uit de ZIP (die bewaart posts.content
  // letterlijk, inclusief [[track:<oud id>]]) en zijn nummers uit de PULL (die
  // gaf ze een nieuw id). De tekst wees dus naar een nummer dat hier niet
  // bestaat, en dan valt hij terug op de kale code.
  const s = site({ aliases: [BRON] });
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
              VALUES ('pz','s1','u1','tiktik','TikTik','<p>[[track:t-oud]]</p>','published','2026-08-13T10:00:00Z')`).run();

  const kaart = new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox`, streams: [`${BRON}/tracks`] }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', orderedItems: [] }],
    [`${BRON}/tracks`, {
      type: 'OrderedCollection',
      orderedItems: [{
        id: `${BRON}/tracks/t-oud`, type: 'Audio', name: 'Nummer',
        url: [{ type: 'Link', href: `${BRON}/audio/x.mp3`, mediaType: 'audio/mpeg' }],
      }],
    }],
  ]);
  await stil(() => Mig.ingestFromSource(s, {
    deps: {
      getJson: async (_slug, url) => kaart.get(url) || null,
      noteId: (b, id) => `${b}/ap/notes/${id}`,
      noteVisibility: AP.noteVisibility,
      audioRoot: '/nep/audio', mediaRoot: '/nep/media',
      signHeaders: () => ({ Signature: 'nep' }),
      safeFetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('x'), headers: { get: () => 'audio/mpeg' } }),
      fs: { mkdirSync() {}, writeFileSync() {} },
      path,
    },
  }));

  // DE EIS, ongeacht hoe: na een verhuizing wijst de shorthand naar een nummer
  // dat hier bestaat. Sinds "altijd behouden" (14-8) klopt dat meestal vanzelf,
  // want het id verandert niet meer. Botst het id wel, dan trekt de ingest de
  // tekst bij. Deze test toetst de UITKOMST en niet de route ernaartoe.
  const inhoud = db.prepare("SELECT content FROM posts WHERE id = 'pz'").get().content;
  const m = /\[\[track:([^\]]+)\]\]/.exec(inhoud);
  assert.ok(m, 'de shorthand blijft staan');
  const bestaat = db.prepare('SELECT 1 FROM audio_tracks WHERE id = ? AND site_id = ?').get(m[1], 's1');
  assert.ok(bestaat, `[[track:${m[1]}]] hoort bij een nummer dat er echt is`);
  assert.equal(m[1], 't-oud', 'en omdat het id behouden blijft, hoefde er niets herschreven');
});

test('botst het track-id wel, dan wordt de tekst bijgetrokken', async () => {
  // Het vangnet. "Altijd behouden" kan niet als er hier al iets anders met dat
  // id staat; dan krijgt het nummer een ander id en moet de shorthand mee.
  const s2 = site({ aliases: [BRON] });
  db.prepare(`INSERT INTO posts (id, site_id, author_id, slug, title, content, status, published_at)
              VALUES ('pb','s1','u1','botsing','Botsing','<p>[[track:t-bots]]</p>','published','2026-08-13T10:00:00Z')`).run();
  // Een nummer dat hier AL bestaat onder datzelfde id, van iets anders.
  db.prepare("INSERT INTO media (id, site_id, filename, mime_type, size, storage_path) VALUES ('mx','s1','x.mp3','audio/mpeg',1,'/x')").run();
  db.prepare("INSERT INTO audio_tracks (id, site_id, title, media_id) VALUES ('t-bots','s1','Al van mij','mx')").run();

  const kaart2 = new Map([
    [BRON, { id: BRON, type: 'Person', movedTo: IK, outbox: `${BRON}/outbox`, streams: [`${BRON}/tracks`] }],
    [`${BRON}/outbox`, { type: 'OrderedCollection', orderedItems: [] }],
    [`${BRON}/tracks`, {
      type: 'OrderedCollection',
      orderedItems: [{
        id: `${BRON}/tracks/t-bots`, type: 'Audio', name: 'Van de bron',
        url: [{ type: 'Link', href: `${BRON}/audio/y.mp3`, mediaType: 'audio/mpeg' }],
      }],
    }],
  ]);
  await stil(() => Mig.ingestFromSource(s2, {
    deps: {
      getJson: async (_slug, url) => kaart2.get(url) || null,
      noteId: (b, id) => `${b}/ap/notes/${id}`,
      noteVisibility: AP.noteVisibility,
      audioRoot: '/nep/audio', mediaRoot: '/nep/media',
      signHeaders: () => ({ Signature: 'nep' }),
      safeFetch: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('y'), headers: { get: () => 'audio/mpeg' } }),
      fs: { mkdirSync() {}, writeFileSync() {} },
      path,
    },
  }));
  // Het bestaande nummer blijft van jou; de tekst wijst naar iets dat bestaat.
  const inhoud = db.prepare("SELECT content FROM posts WHERE id = 'pb'").get().content;
  const m = /\[\[track:([^\]]+)\]\]/.exec(inhoud);
  assert.ok(m);
  assert.ok(db.prepare('SELECT 1 FROM audio_tracks WHERE id = ? AND site_id = ?').get(m[1], 's1'),
    'wat er ook gebeurde met het id, de verwijzing wijst naar een bestaand nummer');
});

test('een niet-publiek bericht komt wel mee maar niet in de publieke tabel', async () => {
  const s = site({ aliases: [BRON] });
  const deps = bronnetje({ items: [note(`${BRON}/notes/priv`, { to: [`${BRON}/followers`] })] });
  const r = await stil(() => Mig.ingestFromSource(s, { deps }));
  assert.equal(r.posts, 1);
  assert.equal(Mig.buildMigration('https://nieuw.example', s).totalItems, 0);
  assert.equal(Mig.buildMigration('https://nieuw.example', s, { alles: true }).totalItems, 1);
});
