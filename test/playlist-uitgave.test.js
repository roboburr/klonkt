// Uitgavevelden op een album-playlist (shaer-756s, stap 1).
//
// Twee kolommen die ALLEEN bij kind='album' horen: een volledige
// uitgavedatum en een MusicBrainz release-id. Ze bestaan omdat hun
// AlbumSerializer `released` als DateField leest en wij alleen `year` hadden --
// en een jaartal als 2024-01-01 versturen is een dag verzinnen.
//
// Wat hier vooral getest wordt is wat er NIET binnenkomt. Het scherm verbergt
// de velden bij een afspeellijst, maar de API ligt open (de post-editor gebruikt
// hem ook), en een scherm is geen bewaking.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
dbMod.initializeDatabase();
const { default: PlaylistService } = await import('../src/services/PlaylistService.js');

db.prepare('INSERT INTO users (id, username, email, password_hash, role) VALUES (?,?,?,?,?)')
  .run('u1', 'u1', 'u1@t', 'x', 'god');
db.prepare('INSERT INTO sites (id, slug, title, owner_id) VALUES (?,?,?,?)')
  .run('s1', 'band', 'De Band', 'u1');

const rij = (id) => db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);

test('een album bewaart een volledige datum en een release-id', () => {
  const id = PlaylistService.create('s1', {
    title: 'De Plaat', kind: 'album',
    release_date: '2024-03-15', mb_release_id: '5441C29D-3602-4898-B1A1-B77FA23B8E50',
  });
  const r = rij(id);
  assert.equal(r.release_date, '2024-03-15');
  assert.equal(r.mb_release_id, '5441c29d-3602-4898-b1a1-b77fa23b8e50', 'mbid gaat naar kleine letters');
});

test('een halve datum wordt NIET aangevuld', () => {
  // Dit is de hele reden dat het veld bestaat naast `year`. Zou hij hier
  // 2024-01-01 van maken, dan stond er een dag op de federatie die niemand
  // heeft ingevoerd.
  for (const slecht of ['2024', '2024-03', '15-03-2024', 'maart 2024', '']) {
    const id = PlaylistService.create('s1', { title: `T${slecht || 'leeg'}`, kind: 'album', release_date: slecht });
    assert.equal(rij(id).release_date, null, `"${slecht}" had geweigerd moeten worden`);
  }
});

test('een bestaande maar onmogelijke datum wordt geweigerd', () => {
  // Date rolt 2024-02-31 stilletjes door naar 2 maart; dan sla je iets anders
  // op dan er ingetypt is.
  const id = PlaylistService.create('s1', { title: 'Onmogelijk', kind: 'album', release_date: '2024-02-31' });
  assert.equal(rij(id).release_date, null);
});

test('een onzin-release-id wordt geweigerd', () => {
  const id = PlaylistService.create('s1', { title: 'Onzin', kind: 'album', mb_release_id: 'niet-een-mbid' });
  assert.equal(rij(id).mb_release_id, null);
});

test('een AFSPEELLIJST krijgt ze niet, ook niet als je ze meestuurt', () => {
  const id = PlaylistService.create('s1', {
    title: 'De Mix', kind: 'playlist',
    release_date: '2024-03-15', mb_release_id: '5441c29d-3602-4898-b1a1-b77fa23b8e50',
  });
  const r = rij(id);
  assert.equal(r.release_date, null);
  assert.equal(r.mb_release_id, null);
});

test('omschakelen naar afspeellijst MAAKT ze leeg', () => {
  // Anders houdt een album dat je tot mixtape ombouwt zijn uitgavedatum, en
  // duikt die weer op zodra iemand hem terugzet.
  const id = PlaylistService.create('s1', {
    title: 'Wordt Mix', kind: 'album', release_date: '2024-03-15',
    mb_release_id: '5441c29d-3602-4898-b1a1-b77fa23b8e50',
  });
  assert.equal(rij(id).release_date, '2024-03-15');
  PlaylistService.update('s1', id, { kind: 'playlist' });   // zegt niets over de velden
  const r = rij(id);
  assert.equal(r.release_date, null, 'uitgavedatum bleef staan op een afspeellijst');
  assert.equal(r.mb_release_id, null);
});

test('bijwerken zonder de velden te noemen laat ze met rust', () => {
  const id = PlaylistService.create('s1', { title: 'Blijft', kind: 'album', release_date: '2024-03-15' });
  PlaylistService.update('s1', id, { title: 'Blijft Ook' });
  assert.equal(rij(id).release_date, '2024-03-15');
});

test('get en list geven de velden door, en houden ze leeg bij een afspeellijst', () => {
  const a = PlaylistService.create('s1', { title: 'Uitgave', kind: 'album', release_date: '2024-03-15' });
  assert.equal(PlaylistService.get('s1', a).release_date, '2024-03-15');
  const inLijst = PlaylistService.list('s1').find((p) => p.id === a);
  assert.equal(inLijst.release_date, '2024-03-15');

  // Rechtstreeks in de kolom zetten op een afspeellijst -- zoals een oude rij
  // eruit zou kunnen zien. Het leespad hoort dat niet door te geven.
  const m = PlaylistService.create('s1', { title: 'Mix2', kind: 'playlist' });
  db.prepare("UPDATE playlists SET release_date = '2024-01-01' WHERE id = ?").run(m);
  assert.equal(PlaylistService.get('s1', m).release_date, '');
});
