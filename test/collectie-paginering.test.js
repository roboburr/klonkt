// Echte paginering (shaer-sk4).
//
// Robin zag dat elke ?page= dezelfde inhoud gaf. Dat klopte: pagedCollection
// veranderde alleen de VORM en sneed nooit, first en last wezen allebei naar
// pagina 1, en pagina 99 noemde zichzelf pagina 1.
//
// De WORTEL houdt zijn items inline, en dat is de hele reden dat dit veilig is:
// Shaer leest een document en volgt `next` niet. Werd de wortel nu leeg, dan
// kreeg elke draaiende app nul items en geen foutmelding.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://ons.test';

const { pagedCollection, PAGINA_GROOTTE } = await import('../src/services/ap-core.js');

const ID = 'https://ons.test/ap/users/dev/followers';
const vijftig = Array.from({ length: 50 }, (_, i) => `https://elders.test/u/${i}`);

test('de wortel draagt ALLES inline, en wijst naar echte grenzen', () => {
  const c = pagedCollection(ID, vijftig);
  assert.equal(c.type, 'OrderedCollection');
  assert.equal(c.orderedItems.length, 50, 'inline, want de app volgt next niet');
  assert.equal(c.first, `${ID}?page=1`);
  assert.equal(c.last, `${ID}?page=3`, '50 items bij 20 per pagina is drie paginas');
});

test('pagina 1 snijdt echt, en biedt een next', () => {
  const p = pagedCollection(ID, vijftig, { page: 1 });
  assert.equal(p.type, 'OrderedCollectionPage');
  assert.equal(p.id, `${ID}?page=1`);
  assert.equal(p.partOf, ID);
  assert.equal(p.orderedItems.length, PAGINA_GROOTTE);
  assert.equal(p.orderedItems[0], vijftig[0]);
  assert.equal(p.next, `${ID}?page=2`);
  assert.equal(p.prev, undefined, 'de eerste heeft geen vorige');
});

test('pagina 2 geeft ANDERE items dan pagina 1 -- dat was de klacht', () => {
  const een = pagedCollection(ID, vijftig, { page: 1 }).orderedItems;
  const twee = pagedCollection(ID, vijftig, { page: 2 }).orderedItems;
  assert.notDeepEqual(een, twee);
  assert.equal(twee[0], vijftig[20]);
  assert.equal(pagedCollection(ID, vijftig, { page: 2 }).prev, `${ID}?page=1`);
});

test('de laatste pagina heeft de rest en GEEN next', () => {
  const p = pagedCollection(ID, vijftig, { page: 3 });
  assert.equal(p.orderedItems.length, 10);
  assert.equal(p.next, undefined);
  assert.equal(p.prev, `${ID}?page=2`);
});

test('een pagina voorbij het einde is leeg en zegt dat ook', () => {
  // Hem naar de laatste terugbuigen zou opnieuw een antwoord zijn dat over
  // zichzelf liegt -- precies wat er mis was.
  const p = pagedCollection(ID, vijftig, { page: 99 });
  assert.equal(p.id, `${ID}?page=99`, 'en niet ?page=1');
  assert.equal(p.orderedItems.length, 0);
  assert.equal(p.next, undefined);
});

test('een lege collectie heeft een pagina, geen nul', () => {
  const c = pagedCollection(ID, []);
  assert.equal(c.first, `${ID}?page=1`);
  assert.equal(c.last, `${ID}?page=1`);
});

test('totalItems telt het GEHEEL, ook op een pagina', () => {
  // De count-only vorm voor het publiek geeft een telling zonder items; die
  // mag een pagina niet stilletjes tot nul maken.
  const p = pagedCollection(ID, vijftig, { page: 2, totalItems: 12345 });
  assert.equal(p.totalItems, 12345);
});
