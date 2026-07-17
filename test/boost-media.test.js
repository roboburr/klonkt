// Cirkel/boost-media: een geboostte video-only post (Loops) verloor zijn media —
// upsertBoostedNote keek alleen naar note.images (afbeeldingen) en de refresh
// overschreef bestaande media_json met []. Dekt de typed-media opslag, de
// niet-clobberen-refresh en de images-fallback af.
//
// Run: npm test   (= node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://klonkt.test';

const dbMod = await import('../src/config/database.js');
const db = dbMod.default;
const AP = await import('../src/services/ActivityPubService.js');

dbMod.initializeDatabase();

const VIDEO_MEDIA = JSON.stringify([{ url: 'https://cdn.test/clip.720p.mp4', type: 'video/mp4' }]);

function mediaOf(id) {
  const r = db.prepare('SELECT media_json FROM ap_timeline WHERE slug = ? AND id = ?').get('me', id);
  return r ? r.media_json : null;
}

test('boost van een video-only post bewaart de video in media_json', () => {
  AP.upsertBoostedNote('me', {
    object_uri: 'https://loops.test/n/1', actor_uri: 'https://loops.test/u/a',
    actor_name: 'A', content: '<p>x</p>', media: VIDEO_MEDIA, images: [],
  });
  const m = JSON.parse(mediaOf('https://loops.test/n/1'));
  assert.equal(m.length, 1);
  assert.equal(m[0].type, 'video/mp4');
});

test('refresh met lege media clobbert een bestaande media_json NIET', () => {
  // rij bestaat al (met video); een re-upsert die niks resolvede mag hem niet wissen
  AP.upsertBoostedNote('me', {
    object_uri: 'https://loops.test/n/1', actor_uri: 'https://loops.test/u/a',
    actor_name: 'A', content: '<p>x2</p>', media: '[]', images: [],
  });
  const m = JSON.parse(mediaOf('https://loops.test/n/1'));
  assert.equal(m.length, 1, 'media_json is gewist door een lege refresh');
  assert.equal(m[0].type, 'video/mp4');
});

test('refresh met nieuwe media werkt de rij wel bij', () => {
  const newer = JSON.stringify([{ url: 'https://cdn.test/clip2.mp4', type: 'video/mp4' }]);
  AP.upsertBoostedNote('me', {
    object_uri: 'https://loops.test/n/1', actor_uri: 'https://loops.test/u/a',
    actor_name: 'A', content: '<p>x3</p>', media: newer, images: [],
  });
  assert.equal(JSON.parse(mediaOf('https://loops.test/n/1'))[0].url, 'https://cdn.test/clip2.mp4');
});

test('images-fallback (oude callers zonder note.media) blijft werken', () => {
  AP.upsertBoostedNote('me', {
    object_uri: 'https://old.test/n/2', actor_uri: 'https://old.test/u/b',
    actor_name: 'B', content: '<p>y</p>', images: ['https://old.test/img.jpg'],
  });
  const m = JSON.parse(mediaOf('https://old.test/n/2'));
  assert.equal(m[0].url, 'https://old.test/img.jpg');
  assert.equal(m[0].type, 'image/jpeg');
});
