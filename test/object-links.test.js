// FEP-e232: Klonkt keeps inbound object-link (quote/ref) tags and serves them on the C2S inbox read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { extractObjectLinkTags, timelineObjectLinks } = await import('../src/services/ActivityPubService.js');
const AP = { extractObjectLinkTags, timelineObjectLinks };

test('extractObjectLinkTags keeps AS2-profiled ld+json and activity+json Links; drops plain links and mentions', () => {
  const tag = [
    { type: 'Link', mediaType: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"', href: 'https://s/objects/1', name: '#1374' },
    { type: 'Link', mediaType: 'application/activity+json', href: 'https://s/objects/2', rel: ['https://misskey-hub.net/ns#_misskey_quote'] },
    { type: 'Link', mediaType: 'text/html', href: 'https://plain.example/page' },  // plain hyperlink → dropped
    { type: 'Mention', href: 'https://s/u/x' },
  ];
  const json = AP.extractObjectLinkTags(tag);
  assert.ok(json);
  const back = AP.timelineObjectLinks(json);
  assert.equal(back.length, 2);
  assert.equal(back[0].href, 'https://s/objects/1');
  assert.equal(back[0].name, '#1374');
  assert.equal(back[1].mediaType, 'application/activity+json');
});

test('no object links → null / undefined (nothing served)', () => {
  assert.equal(AP.extractObjectLinkTags([{ type: 'Link', mediaType: 'text/html', href: 'https://x' }]), null);
  assert.equal(AP.extractObjectLinkTags([{ type: 'Hashtag', name: '#hi' }]), null);
  assert.equal(AP.timelineObjectLinks(null), undefined);
  assert.equal(AP.timelineObjectLinks('not json'), undefined);
});
