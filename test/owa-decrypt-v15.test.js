// PKCS#1 v1.5 zelf uitpakken (shaer-r15).
//
// Node weigert privateDecrypt met RSA_PKCS1_PADDING sinds de mitigatie voor
// CVE-2023-46809, en de revert-vlag bestaat alleen op 18/20/21 -- allemaal EOL.
// FEP-61cf schrijft v1.5 voor, dus OAEP breekt de interop. Blijft over: het
// omhulsel zelf afhalen, met implicit rejection erin.
//
// DEZE TESTS DRAAIEN ZONDER --security-revert. Dat is de hele inzet: als ze
// groen zijn, werkt gastlogin op een Node die nog ondersteund wordt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decryptToken, encryptTokenFor, _nepUitkomst } from '../src/services/OpenWebAuthService.js';

const paar = () => crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const A = paar();
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789._~-';

test('een echt token komt er heel uit, zonder revert-vlag', () => {
  const ct = encryptTokenFor(TOKEN, A.publicKey);
  assert.equal(decryptToken(ct, A.privateKey), TOKEN);
});

test('een verkeerde sleutel WERPT niet maar levert niets op', () => {
  const B = paar();
  const ct = encryptTokenFor(TOKEN, A.publicKey);
  // Werpen is het signaal waar Bleichenbacher op draait. Dat mag hier niet.
  assert.doesNotThrow(() => decryptToken(ct, B.privateKey));
  assert.equal(decryptToken(ct, B.privateKey), null);
});

// Dezelfde meting als waar het oude commentaar op stond, nu tegen de nieuwe weg.
test('300 vreemde sleutels: geen enkele worp, geen enkel token', () => {
  const ct = encryptTokenFor(TOKEN, A.publicKey);
  let worpen = 0, tokens = 0;
  for (let i = 0; i < 300; i++) {
    try { if (decryptToken(ct, paar().privateKey) !== null) tokens++; } catch { worpen++; }
  }
  assert.equal(worpen, 0, 'geen enkele aanroep mag werpen');
  assert.equal(tokens, 0, 'afgeleide onzin mag nooit als token doorgaan');
});

// De eigenschap waar implicit rejection op staat of valt.
test('de nep-uitkomst is DETERMINISTISCH, niet vers willekeurig', () => {
  const ct = Buffer.from('een-ciphertext-om-te-herhalen');
  assert.equal(_nepUitkomst(A.privateKey, ct), _nepUitkomst(A.privateKey, ct),
    'dezelfde ciphertext moet hetzelfde antwoord geven; anders verklikt herhaling het verschil');
  assert.notEqual(_nepUitkomst(A.privateKey, ct), _nepUitkomst(paar().privateKey, ct),
    'en hij moet aan de sleutel hangen, anders is hij te voorspellen');
  assert.notEqual(_nepUitkomst(A.privateKey, ct), _nepUitkomst(A.privateKey, Buffer.from('iets anders')));
});

test('rommel erin werpt ook niet', () => {
  for (const rommel of ['', 'geen base64!!', 'a'.repeat(10), 'x'.repeat(400), null, undefined]) {
    assert.doesNotThrow(() => decryptToken(rommel, A.privateKey), String(rommel).slice(0, 12));
    assert.equal(decryptToken(rommel, A.privateKey), null);
  }
});

// De regels van het omhulsel, ECHT getoetst. Met RSA_NO_PADDING kun je een blok
// naar keuze versleutelen (rauw m^e mod n), dus we kunnen precies bepalen wat er
// na ontsleuteling uit komt -- en dus elke regel apart uitproberen.
const rauwVersleutel = (blok) =>
  crypto.publicEncrypt({ key: A.publicKey, padding: crypto.constants.RSA_NO_PADDING }, blok)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * 00 02 <ps bytes vulling> 00 <boodschap>, met de vulling instelbaar.
 *
 * De boodschap staat tegen het EINDE van het blok: bij PKCS#1 vult hij precies
 * de rest op. Zet je hem er los achter, dan houd je staartnullen over en die
 * sneuvelen terecht op de tekenset-controle -- daar liep mijn eerste opzet op
 * vast, en dat is meteen het bewijs dat deze test iets doet.
 */
function bouwBlok({ kop = [0x00, 0x02], ps = 200, scheider = true } = {}) {
  const k = 256;
  const boodschap = 'a'.repeat(k - 3 - ps);
  const b = Buffer.alloc(k, 0x00);
  b[0] = kop[0]; b[1] = kop[1];
  for (let i = 2; i < 2 + ps; i++) b[i] = 0xAB;      // vulling, nooit nul
  b[2 + ps] = scheider ? 0x00 : 0xAB;
  Buffer.from(boodschap).copy(b, 2 + ps + 1);
  return { blok: b, boodschap };
}

test('een handgemaakt GELDIG omhulsel levert de boodschap op', () => {
  const { blok, boodschap } = bouwBlok({ ps: 200 });
  assert.equal(decryptToken(rauwVersleutel(blok), A.privateKey), boodschap,
    'dit bewijst dat de uitpakker echt uitpakt');
});

test('te korte PS wordt geweigerd: RFC 8017 eist er acht', () => {
  const kort = bouwBlok({ ps: 7 });     // scheider op 9, grens ligt op 10
  assert.equal(decryptToken(rauwVersleutel(kort.blok), A.privateKey), null);
  const net = bouwBlok({ ps: 8 });      // scheider op 10, precies goed
  assert.equal(decryptToken(rauwVersleutel(net.blok), A.privateKey), net.boodschap);
});

test('een verkeerde kop wordt geweigerd', () => {
  for (const kop of [[0x00, 0x01], [0x01, 0x02], [0x00, 0x00]])
    assert.equal(decryptToken(rauwVersleutel(bouwBlok({ kop }).blok), A.privateKey), null, String(kop));
});

test('zonder scheidende nulbyte komt er niets uit', () => {
  const { blok } = bouwBlok({ ps: 200, scheider: false });   // nergens een nulbyte
  assert.equal(decryptToken(rauwVersleutel(blok), A.privateKey), null);
});
