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

// Regression: a hardcoded provider list used to short-circuit here and return a
// card with no title and no thumbnail, so a YouTube link ended up storing
// nothing at all. There is no provider list any more; every non-fediverse URL
// takes the generic path, which is exactly what gives it a thumbnail.
test('a video host is not special-cased and still gets a real card', async () => {
  const r = await resolveEmbed('https://youtu.be/abcdefghijk', io({
    provider: () => ({ provider: 'youtube', id: 'abcdefghijk' }),   // ignored on purpose
    getPage: async () => OEMBED_PAGE,
    getJSON: async () => OEMBED_JSON,
  }));
  assert.equal(r.kind, 'oembed');
  assert.equal(r.title, 'A talk');
  assert.ok(r.media[0].url, 'and it has a thumbnail, which the old path never produced');
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
  // A JSON payload must parse whole, so an oversized one is refused outright.
  assert.equal(await io.getJSON('https://x/huge'), null, 'oversized JSON refused');
  assert.equal(await io.getAP('https://x/boom'), null, 'a refused fetch is not an error');
  assert.deepEqual(await io.getAP('https://x/ok'), { type: 'Note', id: 'https://s/1' });
  assert.ok(calls.some((c) => c[1].includes('activity+json')), 'AP asks for activity+json');
});

// OpenGraph: the one that actually carries link previews on the open web.
// oEmbed is richer, but most sites simply do not ship it, which is why cards
// stayed empty until this fallback existed.
const OG_PAGE = '<html><head><meta property="og:title" content="Linux f&amp;uuml;r Einsteiger">'
  + '<meta property="og:site_name" content="Linux Guides">'
  + '<meta property="og:image" content="https://lg.example/tux.png"></head></html>';

test('findOpenGraph reads og:image/title/site and decodes entities', async () => {
  const { findOpenGraph } = await import('../src/services/EmbedResolver.js');
  const og = findOpenGraph(OG_PAGE);
  assert.equal(og.image, 'https://lg.example/tux.png');
  assert.equal(og.site, 'Linux Guides');
  assert.ok(og.title.startsWith('Linux f'));
  assert.equal(findOpenGraph('<html><head><title>x</title></head></html>'), null);
  assert.equal(findOpenGraph(null), null);
});

test('findOpenGraph falls back to twitter:image and refuses a non-http image', async () => {
  const { findOpenGraph } = await import('../src/services/EmbedResolver.js');
  const tw = findOpenGraph('<meta name="twitter:image" content="https://x/y.png"><meta name="twitter:title" content="T">');
  assert.equal(tw.image, 'https://x/y.png');
  const bad = findOpenGraph('<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="T">');
  assert.equal(bad.image, null, 'a non-http image is dropped, the title survives');
  assert.equal(bad.title, 'T');
});

test('oEmbed still wins over OpenGraph when a page offers both', async () => {
  const both = OEMBED_PAGE.replace('</head>', '<meta property="og:title" content="OG"></head>');
  const r = await resolveEmbed('https://v.example/1', io({
    getPage: async () => both, getJSON: async () => OEMBED_JSON,
  }));
  assert.equal(r.kind, 'oembed');
  assert.equal(r.title, 'A talk');
});

test('a page with only OpenGraph yields a thumbnail card', async () => {
  const r = await resolveEmbed('https://lg.example/artikel', io({ getPage: async () => OG_PAGE }));
  assert.equal(r.kind, 'opengraph');
  assert.equal(r.media[0].url, 'https://lg.example/tux.png');
  assert.equal(r.provider, 'Linux Guides');
  assert.equal(r.url, 'https://lg.example/artikel');
});

// Regression, the one that kept YouTube blank: a page is read from the START and
// cut off, never refused for being large. Refusing it meant no thumbnail at all
// for exactly the sites people share most.
test('a huge page is truncated, not rejected', async () => {
  const { liveIO } = await import('../src/services/EmbedResolver.js');
  const big = '<html><head>' + 'x'.repeat(5000) + '<meta property="og:title" content="T">'
    + '<meta property="og:image" content="https://x/i.png"></head></html>';
  const fakeFetch = async () => ({ ok: true, headers: { get: () => String(9_000_000) }, text: async () => big });
  const io = liveIO({ safeFetch: fakeFetch, detectProvider: () => null });
  const page = await io.getPage('https://x/huge');
  assert.ok(page && page.includes('og:image'), 'the head survives the cap');
});

// Regression: big sites carry the bare string "og:image" inside inline JSON long
// before the real meta tag. Stopping the read there cut the page off just short
// of the tags and produced no card at all.
test('the head read does not stop on an og:image mention inside a script', async () => {
  const { liveIO } = await import('../src/services/EmbedResolver.js');
  const page = '<html><head><script>var cfg={"og:image":"decoy"};</script>'
    + 'y'.repeat(3000)
    + '<meta property="og:title" content="Echt"><meta property="og:image" content="https://x/real.png">'
    + '</head></html>';
  const fakeFetch = async () => ({ ok: true, headers: { get: () => '999' }, text: async () => page });
  const io = liveIO({ safeFetch: fakeFetch, detectProvider: () => null });
  const got = await io.getPage('https://x/p');
  const { findOpenGraph } = await import('../src/services/EmbedResolver.js');
  assert.equal(findOpenGraph(got).image, 'https://x/real.png', 'reads past the decoy to the real tag');
});

// The public oEmbed registry (oembed.com). Not a list we maintain: we read one
// that is published. It exists because discovery through the page fails exactly
// where it matters most, from a server YouTube hands a stripped page to.
const PROVIDERS = [
  { provider_name: 'YouTube', provider_url: 'https://www.youtube.com/',
    endpoints: [{ schemes: ['https://*.youtube.com/watch*', 'https://youtu.be/*'], url: 'https://www.youtube.com/oembed' }] },
  { provider_name: 'Bare', provider_url: 'https://bare.example/', endpoints: [{ url: 'https://bare.example/oembed.{format}' }] },
];

test('matchProviderEndpoint matches wildcard schemes and falls back to the host', async () => {
  const { matchProviderEndpoint } = await import('../src/services/EmbedResolver.js');
  assert.equal(matchProviderEndpoint('https://youtu.be/abc?is=x', PROVIDERS), 'https://www.youtube.com/oembed');
  assert.equal(matchProviderEndpoint('https://www.youtube.com/watch?v=abc', PROVIDERS), 'https://www.youtube.com/oembed');
  assert.equal(matchProviderEndpoint('https://bare.example/thing/1', PROVIDERS), 'https://bare.example/oembed.json',
    'no schemes listed, so the provider host decides, and {format} is filled in');
  assert.equal(matchProviderEndpoint('https://elders.example/x', PROVIDERS), null);
  assert.equal(matchProviderEndpoint('not a url', PROVIDERS), null);
});

test('oembedRequestUrl appends url + format, keeping an existing query', async () => {
  const { oembedRequestUrl } = await import('../src/services/EmbedResolver.js');
  assert.ok(oembedRequestUrl('https://x/oembed', 'https://a/b?c=1').includes('format=json&url=https%3A%2F%2Fa%2Fb%3Fc%3D1'));
  assert.ok(oembedRequestUrl('https://x/oembed?k=1', 'https://a/b').startsWith('https://x/oembed?k=1&'));
});

test('the registry is tried before the page, and the page is not fetched when it hits', async () => {
  let pageFetched = false;
  const r = await resolveEmbed('https://youtu.be/abc', io({
    registry: async () => PROVIDERS,
    getJSON: async () => OEMBED_JSON,
    getPage: async () => { pageFetched = true; return OG_PAGE; },
  }));
  assert.equal(r.kind, 'oembed');
  assert.equal(r.title, 'A talk');
  assert.ok(!pageFetched, 'a registry hit saves the whole page download');
});

test('an unreachable registry just falls through to the page', async () => {
  const r = await resolveEmbed('https://lg.example/a', io({
    registry: async () => { throw new Error('offline'); },
    getPage: async () => OG_PAGE,
  }));
  assert.equal(r.kind, 'opengraph');
});
