// Wie mag wat zien van een bericht -- op ÉÉN plek.
//
// Het besluit zat alleen in de postroute, waar het een andere PAGINA rendert
// (paid-gate/fan-gate). De tijdlijn gaat hele berichten tonen en heeft hetzelfde
// besluit nodig als een stuk. Twee plekken die allebei zelf bepalen wie een
// betaalde tekst mag lezen, is een lek dat op een gelegenheid wacht -- vandaar
// deze module, en vandaar dat de toetsen hier scherper staan dan elders.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const { postAccess, canReadBody, paidTeaser } = await import('../src/services/PostAccessService.js');

const SITE = { id: 's1', slug: 'demo', owner_id: 'u1' };
const OWNER = { id: 'u1', role: 'god' };
const VREEMDE = null;
const INGELOGD = { id: 'u2', role: 'user' };

const post = (extra = {}) => ({
  id: 'p1', slug: 'hallo', status: 'published', site_id: 's1', author_id: 'u1',
  content: '<p>eerste alinea</p><p>tweede alinea</p>', ...extra,
});

test('een gewoon bericht is voor iedereen', () => {
  assert.equal(postAccess(post(), { user: VREEMDE, site: SITE }), 'full');
  assert.equal(canReadBody(post(), { user: VREEMDE, site: SITE }), true);
});

test('een concept is van de maker, en van niemand anders', () => {
  const concept = post({ status: 'draft' });
  assert.equal(postAccess(concept, { user: VREEMDE, site: SITE }), 'forbidden');
  assert.equal(postAccess(concept, { user: INGELOGD, site: SITE }), 'forbidden');
  assert.equal(postAccess(concept, { user: OWNER, site: SITE }), 'full', 'de eigenaar ziet zijn eigen concept');
});

test('fan-only vraagt om inloggen, niet om betalen', () => {
  const f = post({ fan_only: 1 });
  assert.equal(postAccess(f, { user: VREEMDE, site: SITE }), 'fan');
  assert.equal(postAccess(f, { user: INGELOGD, site: SITE }), 'full', 'ingelogd is genoeg');
});

test('betaald blijft betaald tot er een geldig bewijs ligt', () => {
  const b = post({ paid: 1 });
  assert.equal(postAccess(b, { user: VREEMDE, site: SITE }), 'paid');
  assert.equal(postAccess(b, { user: INGELOGD, site: SITE }), 'paid',
    'inloggen koopt niets: een Klonkt-account is geen supporter');
  assert.equal(postAccess(b, { user: VREEMDE, site: SITE, unlockedSlug: 'hallo' }), 'full');
});

test('een bewijs voor een ANDER bericht opent dit bericht niet', () => {
  // De gevaarlijke vorm: één keer betalen en dan de hele site lezen.
  const b = post({ paid: 1 });
  assert.equal(postAccess(b, { user: VREEMDE, site: SITE, unlockedSlug: 'een-ander' }), 'paid');
  assert.equal(postAccess(b, { user: VREEMDE, site: SITE, unlockedSlug: '' }), 'paid');
  assert.equal(postAccess(b, { user: VREEMDE, site: SITE, unlockedSlug: null }), 'paid');
});

test('betaald WINT van fan-only, en die volgorde is geen detail', () => {
  // Een bericht dat allebei is gaat open met een passkey, niet met een login.
  // Andersom belandt een anonieme supporter op het inlogscherm en ziet hij de
  // ontgrendelknop nooit -- de reden dat deze volgorde in de route stond.
  const beide = post({ paid: 1, fan_only: 1 });
  assert.equal(postAccess(beide, { user: VREEMDE, site: SITE }), 'paid');
  assert.equal(postAccess(beide, { user: INGELOGD, site: SITE }), 'paid',
    'ook ingelogd: de betaalmuur staat vooraan');

  // TWEE POORTEN ACHTER ELKAAR, en dat is de bestaande werking -- overgenomen
  // uit de route, niet hier bedacht. Wie betaalt maar niet ingelogd is, staat
  // na het ontgrendelen alsnog voor de fanpoort:
  assert.equal(postAccess(beide, { user: VREEMDE, site: SITE, unlockedSlug: 'hallo' }), 'fan');
  // Betalen ÉN ingelogd komt er wel doorheen.
  assert.equal(postAccess(beide, { user: INGELOGD, site: SITE, unlockedSlug: 'hallo' }), 'full');
});

test('de eigenaar loopt niet tegen zijn eigen muur op', () => {
  assert.equal(postAccess(post({ paid: 1, fan_only: 1 }), { user: OWNER, site: SITE }), 'full');
});

test('geen bericht is geen toegang', () => {
  assert.equal(postAccess(null, { user: OWNER, site: SITE }), 'forbidden');
  assert.equal(postAccess(undefined, {}), 'forbidden');
});

test('de teaser lekt nooit voorbij de eerste alinea', () => {
  // Dit is de hele belofte van een betaalmuur: wat hierna komt, komt er niet uit.
  const t = paidTeaser(post({ paid: 1 }));
  assert.match(t, /eerste alinea/);
  assert.ok(!t.includes('tweede'), 'de tweede alinea blijft binnen');
});

test('een expliciete excerpt gaat voor', () => {
  assert.equal(paidTeaser(post({ excerpt: 'zelf geschreven' })), 'zelf geschreven');
});

// ── Wat de tijdlijn krijgt ────────────────────────────────────────────────
// De tijdlijn toont hele berichten, dus een gesloten bericht moet zijn plek
// houden ZONDER dat de tekst meereist. Dat is geen sjabloonkwestie: wat niet
// gerenderd wordt, kan ook niet per ongeluk getoond worden.

const { postEntry } = await import('../src/services/PostAccessService.js');
const renderBody = (p) => `<div>GEHEIM: ${p.content}</div>`;

test('een open bericht krijgt zijn lijf', () => {
  const e = postEntry(post(), { user: VREEMDE, site: SITE }, { renderBody });
  assert.equal(e.access, 'full');
  assert.match(e.content_html, /GEHEIM/);
  assert.equal(e.teaser, null, 'geen teaser NAAST het lijf');
});

test('een betaald bericht reist zonder tekst', () => {
  const e = postEntry(post({ paid: 1 }), { user: VREEMDE, site: SITE }, { renderBody });
  assert.equal(e.access, 'paid');
  assert.equal(e.content_html, null, 'het lijf wordt niet eens gerenderd');
  assert.match(e.teaser, /eerste alinea/);
  assert.ok(!JSON.stringify(e).includes('tweede alinea'), 'en niets erachter lekt mee');
});

test('een fan-bericht ook niet', () => {
  const e = postEntry(post({ fan_only: 1 }), { user: VREEMDE, site: SITE }, { renderBody });
  assert.equal(e.access, 'fan');
  assert.equal(e.content_html, null);
});

test('een concept levert helemaal niets op', () => {
  const e = postEntry(post({ status: 'draft' }), { user: VREEMDE, site: SITE }, { renderBody });
  assert.equal(e.access, 'forbidden');
  assert.equal(e.content_html, null);
  assert.equal(e.teaser, null, 'ook geen teaser: over een concept valt niets te zeggen');
});

test('zonder renderer nog steeds geen lijf, en geen fout', () => {
  const e = postEntry(post(), { user: VREEMDE, site: SITE });
  assert.equal(e.access, 'full');
  assert.equal(e.content_html, null);
});
