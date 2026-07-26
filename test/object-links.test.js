// FEP-e232: Klonkt keeps inbound object-link (quote/ref) tags and serves them on the C2S inbox read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';
const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { extractObjectLinkTags, timelineObjectLinks, extractQuoteUrl, extractLinkJson } = await import('../src/services/ActivityPubService.js');
const AP = { extractObjectLinkTags, timelineObjectLinks, extractQuoteUrl, extractLinkJson };

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

// FEP-044f: object-level quote properties are the common representation.
test('extractQuoteUrl reads quote / quoteUrl / quoteUri / _misskey_quote (string or embedded object)', () => {
  assert.equal(AP.extractQuoteUrl({ quote: 'https://s/objects/9' }), 'https://s/objects/9');
  assert.equal(AP.extractQuoteUrl({ quoteUrl: 'https://s/q1' }), 'https://s/q1');
  assert.equal(AP.extractQuoteUrl({ quoteUri: 'https://s/q2' }), 'https://s/q2');
  assert.equal(AP.extractQuoteUrl({ _misskey_quote: 'https://s/q3' }), 'https://s/q3');
  assert.equal(AP.extractQuoteUrl({ quote: { type: 'Link', href: 'https://s/q4' } }), 'https://s/q4');
  assert.equal(AP.extractQuoteUrl({ content: 'no quote' }), null);
});

test('extractLinkJson normalises an object-level quote into one FEP-e232 Link (rel _misskey_quote)', () => {
  const json = AP.extractLinkJson({ content: 'nice', quoteUrl: 'https://s/objects/9' });
  const arr = AP.timelineObjectLinks(json);
  assert.equal(arr.length, 1);
  assert.equal(arr[0].href, 'https://s/objects/9');
  assert.ok(arr[0].rel.some((r) => r.includes('quote')));
});

test('extractLinkJson merges a real FEP-e232 Link with an object-level quote, deduped by href', () => {
  const note = {
    tag: [{ type: 'Link', mediaType: 'application/activity+json', href: 'https://s/objects/9' }],
    quoteUrl: 'https://s/objects/9',   // same target → not duplicated
  };
  const arr = AP.timelineObjectLinks(AP.extractLinkJson(note));
  assert.equal(arr.length, 1);
  assert.equal(arr[0].href, 'https://s/objects/9');
});
