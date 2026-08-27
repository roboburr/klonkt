// Een C2S-antwoord houdt ALLE mentions die de client stuurde (Robins melding,
// 26-8). Dat deed het niet: de inname gaf deliverReply geen `mentions` mee, en
// dat betekent daar "oud gedrag -- noem alleen de auteur van de ouder". Wie er
// drie stuurde zag er dus een gepubliceerd worden.
//
// Getoetst op wat er de deur uit gaat: de Mention-tags op de note, want dat is
// wat de ontvangende kant leest.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
{ const stil = console.log; console.log = () => {}; try { dbMod.initializeDatabase(); } finally { console.log = stil; } }
const APmod = await import('../src/services/ActivityPubService.js');
const AP = APmod.default;

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'robin', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id, is_primary) VALUES (?,?,?,?,1)').run('s1', 'kid', 'kid', 'u1');
const site = db.prepare('SELECT * FROM sites WHERE slug = ?').get('kid');
const user = db.prepare('SELECT * FROM users WHERE id = ?').get('u1');

// De ouder waarop geantwoord wordt: een eigen post, zodat er geen netwerk aan
// te pas komt. resolveRemoteNote leest die rechtstreeks uit de databank.
db.prepare(`INSERT INTO posts (id, site_id, slug, author_id, title, content, excerpt, status, type, language, created_at, updated_at, published_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run('p1', 's1', 'de-post', 'u1', '', '<p>de ouder</p>', '', 'published', 'post', 'nl',
    '2026-08-26T09:00:00Z', '2026-08-26T09:00:00Z', '2026-08-26T09:00:00Z');

const OUDER = 'https://test.example/ap/notes/p1';
const BART = 'https://pruts.nl/ap/users/bart';
const ESMEE = 'https://boiert.eu/users/esmee';

async function antwoord(tags) {
  const r = await AP.ingestOutboxActivity(site, user, {
    type: 'Create',
    object: {
      type: 'Note',
      inReplyTo: OUDER,
      content: '<p>ja, mee eens</p>',
      source: { content: 'ja, mee eens', mediaType: 'text/plain' },
      to: [`https://test.example/ap/users/kid/followers`],
      cc: ['https://www.w3.org/ns/activitystreams#Public'],
      ...(tags ? { tag: tags } : {}),
    },
  });
  assert.equal(r.status, 201, `het antwoord hoort te landen, kreeg ${r.status} ${r.error || ''}`);
  const rij = db.prepare('SELECT * FROM ap_outbox WHERE id = ?').get(r.id);
  return AP.buildNote('https://test.example', site, rij, { isReply: true });
}

const mentionsVan = (note) => (note.tag || []).filter((t) => t.type === 'Mention').map((t) => t.href).sort();

test('drie meegestuurde mentions worden er drie, niet een', async () => {
  const note = await antwoord([
    { type: 'Mention', href: AP.actorId('https://test.example', 'kid'), name: '@kid@test.example' },
    { type: 'Mention', href: BART, name: '@bart@pruts.nl' },
    { type: 'Mention', href: ESMEE, name: '@esmee@boiert.eu' },
  ]);
  assert.deepEqual(mentionsVan(note), [ESMEE, BART, AP.actorId('https://test.example', 'kid')].sort(),
    'alle drie de genoemden staan als Mention op de note');
});

test('een dubbele mention telt een keer, en een raar adres telt niet mee', async () => {
  const note = await antwoord([
    { type: 'Mention', href: BART, name: '@bart@pruts.nl' },
    { type: 'Mention', href: BART, name: '@bart@pruts.nl' },   // dezelfde
    { type: 'Mention', href: 'javascript:alert(1)', name: '@stout' },
    { type: 'Hashtag', href: 'https://pruts.nl/tags/muziek', name: '#muziek' },
  ]);
  assert.deepEqual(mentionsVan(note), [BART], 'ontdubbeld, en alleen echte Mentions met een http-adres');
});

test('zonder tags blijft het oude gedrag: de auteur van de ouder', async () => {
  // Een client die geen tags kent hoort niet stil zonder mentions te eindigen.
  const note = await antwoord(null);
  assert.deepEqual(mentionsVan(note), [AP.actorId('https://test.example', 'kid')],
    'de ouder-auteur wordt genoemd, zoals altijd');
});
