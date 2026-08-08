// De SSRF-poort mag gericht open voor een testkudde op de eigen machine
// (shaer-6wt, Barts vraag 8-8: "waarom via https? gewoon localhost ::1").
//
// Wat hier bewaakt wordt is de SMALHEID. De bescherming bestaat omdat een
// actor-URI van een vreemde komt; een brede "loopback mag"-vlag zou hem in een
// dev-omgeving uitzetten, en dev-omgevingen worden productie. Een lijst van
// precieze host:poort-paren opent precies wat erin staat en niets ernaast.
//
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.AP_ALLOW_HOSTS = '[::1]:3060';
const AP = await import('../src/services/ActivityPubService.js');

const faalt = async (url) => {
  try { await AP.safeFetch(url); return null; }
  catch (e) { return e.message; }
};

test('wat er WEL op staat komt langs de poort', async () => {
  // De slaagtest, en zonder hem is de rest waardeloos: alleen weigeringen
  // toetsen laat de suite groen terwijl er niets doorheen komt. Er draait hier
  // niets op 3060, dus we verwachten een VERBINDINGSfout -- het bewijs is dat
  // het geen ssrf-fout is.
  const fout = await faalt('http://[::1]:3060/u/w001');
  assert.ok(fout, 'er is wel degelijk een fout, want er luistert niets');
  assert.ok(!String(fout).startsWith('ssrf-'), `door de poort, maar kreeg: ${fout}`);
});

test('een adres dat NIET op de lijst staat blijft geweigerd', async () => {
  // Zelfde machine, andere poort. Zou dit doorlaten, dan is de lijst een vlag.
  assert.equal(await faalt('http://[::1]:3061/u/w001'), 'ssrf-blocked-ip');
});

test('en 127.0.0.1 evenmin, ook al is het dezelfde machine', async () => {
  // De lijst opent een HOST:POORT, geen begrip van "lokaal".
  assert.equal(await faalt('http://127.0.0.1:3060/u/w001'), 'ssrf-blocked-ip');
});

test('het metadata-adres blijft dicht', async () => {
  // Waar de bescherming voor bestaat.
  assert.equal(await faalt('http://169.254.169.254/latest/meta-data/'), 'ssrf-blocked-ip');
});

test('zonder de omgevingsvariabele is er geen uitzondering', async () => {
  // De lijst is leeg tenzij iemand hem expliciet vult. Dit is de stand waarin
  // elke productie-instance draait.
  const eerder = process.env.AP_ALLOW_HOSTS;
  delete process.env.AP_ALLOW_HOSTS;
  const mod = await import(`../src/services/ActivityPubService.js?leeg=${Date.now()}`);
  let fout = null;
  try { await mod.safeFetch('http://[::1]:3060/u/w001'); } catch (e) { fout = e.message; }
  assert.equal(fout, 'ssrf-blocked-ip');
  process.env.AP_ALLOW_HOSTS = eerder;
});

test('een ander schema blijft hoe dan ook geweigerd', async () => {
  assert.equal(await faalt('file:///etc/passwd'), 'ssrf-bad-scheme');
});
