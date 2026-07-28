// One embed pipeline (shaer-277): AP first (FEP semantics), then a known
// provider, then oEmbed, then a plain link. All four end in the same shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEmbed, findOEmbedEndpoint, looksLikeAPObject, fromOEmbed,
} from '../src/services/EmbedResolver.js';

const AP_NOTE = { id: 'https://s/objects/1', type: 'Note', content: '<p>hi</p>', attributedTo: 'https://s/users/alice', url: 'https://s/@alice/1' };
const OEMBED_PAGE = '<html><head><link rel="alternate" type="application/json+oembed" href="https://v.example/oembed?url=x&amp;f=json"><title>t</title></head></html>';
const OEMBED_JSON = { type: 'video', title: 'A talk', author_name: 'Ada', provider_name: 'Vid', html: '<iframe src="https://v.example/e/1"></iframe>', thumbnail_url: 'https://v.example/t.jpg' };

const io = (over = {}) => ({
  getAP: async () => null,
  getPage: async () => null,
  getJSON: async () => null,
  actorOf: async () => ({ name: 'Alice', handle: '@alice@s', icon: null }),
  provider: () => null,
  ...over,
});

test('findOEmbedEndpoint reads the json+oembed link and decodes entities', () => {
  assert.equal(findOEmbedEndpoint(OEMBED_PAGE), 'https://v.example/oembed?url=x&f=json');
  assert.equal(findOEmbedEndpoint('<html><head></head></html>'), null);
  // the XML flavour is not parsed
  assert.equal(findOEmbedEndpoint('<link rel="alternate" type="text/xml+oembed" href="https://x/o">'), null);
});

test('looksLikeAPObject accepts quotable content, rejects actors and activities', () => {
  assert.ok(looksLikeAPObject(AP_NOTE));
  assert.ok(looksLikeAPObject({ id: 'https://s/v/1', type: 'Video' }));
  assert.ok(!looksLikeAPObject({ id: 'https://s/users/a', type: 'Person' }));
  assert.ok(!looksLikeAPObject({ id: 'https://s/a/1', type: 'Create' }));
  assert.ok(!looksLikeAPObject({ type: 'Note' }));      // no id
  assert.ok(!looksLikeAPObject(null));
});

test('an ActivityPub object resolves over AP, never over oEmbed', async () => {
  let pageFetched = false;
  const r = await resolveEmbed('https://s/@alice/1', io({
    getAP: async () => AP_NOTE,
    getPage: async () => { pageFetched = true; return OEMBED_PAGE; },
    getJSON: async () => OEMBED_JSON,
    provider: () => ({ provider: 'youtube', id: 'x' }),   // must not win either
  }));
  assert.equal(r.kind, 'ap');
  assert.equal(r.id, 'https://s/objects/1');
  assert.equal(r.attributedTo, 'https://s/users/alice');
  assert.equal(r.author.handle, '@alice@s');
  assert.equal(r.url, 'https://s/@alice/1');
  assert.ok(!pageFetched, 'AP wins before any oEmbed discovery happens');
});

test('a known provider beats oEmbed but loses to AP', async () => {
  const r = await resolveEmbed('https://youtu.be/abcdefghijk', io({
    provider: () => ({ provider: 'youtube', id: 'abcdefghijk' }),
    getPage: async () => OEMBED_PAGE,
    getJSON: async () => OEMBED_JSON,
  }));
  assert.equal(r.kind, 'provider');
  assert.equal(r.provider, 'youtube');
});

test('anything else goes through oEmbed discovery', async () => {
  const r = await resolveEmbed('https://v.example/watch/1', io({
    getPage: async () => OEMBED_PAGE,
    getJSON: async () => OEMBED_JSON,
  }));
  assert.equal(r.kind, 'oembed');
  assert.equal(r.title, 'A talk');
  assert.equal(r.author.name, 'Ada');
  assert.equal(r.provider, 'Vid');
  assert.equal(r.media[0].url, 'https://v.example/t.jpg');
  assert.ok(r.html.startsWith('<iframe'));
});

test('no oEmbed link, or a dead endpoint, still yields a usable link card', async () => {
  const noLink = await resolveEmbed('https://plain.example/p', io({ getPage: async () => '<html></html>' }));
  assert.equal(noLink.kind, 'link');
  const deadEndpoint = await resolveEmbed('https://v.example/p', io({
    getPage: async () => OEMBED_PAGE, getJSON: async () => null,
  }));
  assert.equal(deadEndpoint.kind, 'link');
});

test('a failing AP fetch does not abort the pipeline', async () => {
  const r = await resolveEmbed('https://v.example/p', io({
    getAP: async () => { throw new Error('boom'); },
    getPage: async () => OEMBED_PAGE,
    getJSON: async () => OEMBED_JSON,
  }));
  assert.equal(r.kind, 'oembed');
});

test('non-http input is refused', async () => {
  assert.equal(await resolveEmbed('javascript:alert(1)', io()), null);
  assert.equal(await resolveEmbed('', io()), null);
});

test('fromOEmbed keeps only an http(s) canonical url', () => {
  const c = fromOEmbed('https://a/b', { url: 'javascript:alert(1)', title: 'x' });
  assert.equal(c.url, 'https://a/b');
});

// The live binding: the ordering above stays, but every fetch is capped and
// goes through safeFetch, so a URL in a post cannot make us probe internals.
test('liveIO caps oversized bodies and never throws on a bad fetch', async () => {
  const { liveIO } = await import('../src/services/EmbedResolver.js');
  const calls = [];
  const fakeFetch = async (u, o) => {
    calls.push([u, o.headers.Accept]);
    if (u.includes('huge')) return { ok: true, headers: { get: () => String(9_000_000) }, text: async () => 'x' };
    if (u.includes('boom')) throw new Error('refused');
    return { ok: true, headers: { get: () => '10' }, text: async () => '{"type":"Note","id":"https://s/1"}' };
  };
  const io = liveIO({ safeFetch: fakeFetch, detectProvider: () => null });
  assert.equal(await io.getPage('https://x/huge'), null, 'oversized body refused');
  assert.equal(await io.getAP('https://x/boom'), null, 'a refused fetch is not an error');
  assert.deepEqual(await io.getAP('https://x/ok'), { type: 'Note', id: 'https://s/1' });
  assert.ok(calls.some((c) => c[1].includes('activity+json')), 'AP asks for activity+json');
});
