// De sleutel moet horen bij de actor waarvoor hij spreekt.
//
// verifyRequest haalde het actor-document op bij de keyId uit de handtekening en gaf
// dat document daarna terug zoals het was. De inbox beslist op `verified.id`, dus op
// wat het document over ZICHZELF beweert. Wie een document neerzet met de id van zijn
// slachtoffer naast zijn EIGEN publieke sleutel, en ondertekent met zijn eigen private
// helft, werd geloofd. De server van het slachtoffer wordt daarbij nooit geraadpleegd.
//
// Alle hosts hier zijn IP-literals uit de documentatiereeksen: assertPublicHost doet
// dan geen DNS-opzoeking, en globalThis.fetch is gestubd, dus deze test gaat nooit
// echt het netwerk op.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.DATABASE_PATH = ':memory:';
process.env.PUBLIC_BASE_URL = 'https://test.example';

const dbMod = await import('../src/config/database.js');
dbMod.initializeDatabase();
const AP = await import('../src/services/ActivityPubService.js');

const AANVALLER = 'https://203.0.113.90';   // TEST-NET-3, de server van de aanvaller
const SLACHTOFFER = 'https://198.51.100.7'; // TEST-NET-2, de echte server

// Eén sleutelpaar: dat van de aanvaller. Het slachtoffer geeft zijn private helft
// natuurlijk nooit weg, en dat is precies waarom de aanval op de identiteit mikt
// in plaats van op de wiskunde.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

let documenten;      // url -> JSON dat de nep-fetch teruggeeft
let opgehaald;       // welke urls zijn werkelijk opgevraagd
const echteFetch = globalThis.fetch;

beforeEach(() => {
  documenten = new Map();
  opgehaald = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    opgehaald.push(u);
    const doc = documenten.get(u);
    if (!doc) return new Response('niet gevonden', { status: 404 });
    return new Response(JSON.stringify(doc), {
      status: 200,
      headers: { 'Content-Type': 'application/activity+json' },
    });
  };
});

afterEach(() => { globalThis.fetch = echteFetch; });

// Bouwt een echt ondertekend verzoek, zoals een federerende server het stuurt.
function ondertekendVerzoek(keyId, { host = 'test.example', pad = '/ap/users/robin/inbox' } = {}) {
  const datum = new Date().toUTCString();
  const regels = [
    `(request-target): post ${pad}`,
    `host: ${host}`,
    `date: ${datum}`,
  ].join('\n');
  const signature = crypto.sign('sha256', Buffer.from(regels), privateKey).toString('base64');
  return {
    method: 'POST',
    originalUrl: pad,
    headers: {
      host,
      date: datum,
      signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
    },
  };
}

test('een document dat een ANDERE actor claimt wordt geweigerd', async () => {
  // De aanvaller zet op zijn eigen server een document neer dat zegt dat het het
  // slachtoffer is, met zijn eigen sleutel erin.
  documenten.set(`${AANVALLER}/users/dief`, {
    id: `${SLACHTOFFER}/users/slachtoffer`,          // <-- de gestolen naam
    type: 'Person',
    publicKey: {
      id: `${AANVALLER}/users/dief#main-key`,
      owner: `${AANVALLER}/users/dief`,
      publicKeyPem: publicKey,
    },
  });

  const req = ondertekendVerzoek(`${AANVALLER}/users/dief#main-key`);
  const uit = await AP.verifyRequest(req);

  assert.equal(uit, null, 'een document mag niet de identiteit van een andere host kunnen claimen');
  // En het belangrijkste: de echte server van het slachtoffer is nooit geraadpleegd,
  // dus die kan dit ook niet merken of tegenspreken.
  assert.ok(
    !opgehaald.some((u) => u.startsWith(SLACHTOFFER)),
    'de server van het slachtoffer wordt niet eens bevraagd, vandaar de controle aan onze kant',
  );
});

test('een geldige ondertekenaar op zijn eigen host komt er wel door', async () => {
  documenten.set(`${AANVALLER}/users/eerlijk`, {
    id: `${AANVALLER}/users/eerlijk`,
    type: 'Person',
    publicKey: {
      id: `${AANVALLER}/users/eerlijk#main-key`,
      owner: `${AANVALLER}/users/eerlijk`,
      publicKeyPem: publicKey,
    },
  });

  const uit = await AP.verifyRequest(ondertekendVerzoek(`${AANVALLER}/users/eerlijk#main-key`));

  assert.ok(uit, 'gewone federatie mag hier niet op stuklopen');
  assert.equal(uit.id, `${AANVALLER}/users/eerlijk`);
});

test('de sleutel van een buurman op dezelfde host werkt niet', async () => {
  // Zelfde host, dus de herkomstcontrole alleen is niet genoeg: dit document plakt
  // het sleutelblok van iemand anders in.
  documenten.set(`${AANVALLER}/users/buurman`, {
    id: `${AANVALLER}/users/buurman`,
    type: 'Person',
    publicKey: {
      id: `${AANVALLER}/users/iemand-anders#main-key`,   // <-- niet de keyId waarmee ondertekend is
      owner: `${AANVALLER}/users/iemand-anders`,
      publicKeyPem: publicKey,
    },
  });

  const uit = await AP.verifyRequest(ondertekendVerzoek(`${AANVALLER}/users/buurman#main-key`));
  assert.equal(uit, null, 'de keyId moet de sleutel zijn die de actor adverteert');
});

test('een sleutelblok met een vreemde owner wordt geweigerd', async () => {
  documenten.set(`${AANVALLER}/users/knip`, {
    id: `${AANVALLER}/users/knip`,
    type: 'Person',
    publicKey: {
      id: `${AANVALLER}/users/knip#main-key`,
      owner: `${SLACHTOFFER}/users/slachtoffer`,          // <-- owner wijst ergens anders
      publicKeyPem: publicKey,
    },
  });

  const uit = await AP.verifyRequest(ondertekendVerzoek(`${AANVALLER}/users/knip#main-key`));
  assert.equal(uit, null, 'owner moet naar de actor zelf wijzen');
});

test('een verdraaide handtekening blijft falen, ook bij een kloppend document', async () => {
  // Bewijst dat de nieuwe controles de handtekeningcontrole niet vervangen maar
  // ervoor komen: de wiskunde moet nog steeds kloppen.
  documenten.set(`${AANVALLER}/users/eerlijk`, {
    id: `${AANVALLER}/users/eerlijk`,
    type: 'Person',
    publicKey: {
      id: `${AANVALLER}/users/eerlijk#main-key`,
      owner: `${AANVALLER}/users/eerlijk`,
      publicKeyPem: publicKey,
    },
  });

  const req = ondertekendVerzoek(`${AANVALLER}/users/eerlijk#main-key`);
  req.headers.signature = req.headers.signature.replace(/signature="[^"]*"$/, 'signature="AAAA"');

  assert.equal(await AP.verifyRequest(req), null);
});
