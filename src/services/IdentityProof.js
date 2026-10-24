/**
 * Identiteitsbewijzen (FEP-c390, shaer-jpxj).
 *
 * Een sleutel die NIET op deze server staat -- bij Shaer op papier, 24 woorden,
 * alleen ingetypt als hij nodig is -- ondertekent een verklaring: "did:key:...
 * is ook <deze actor>". Deze server ondertekent NIETS. Hij controleert de
 * verklaring en zet hem onder `attachment` op de actor, waar iedereen hem zelf
 * kan nalopen.
 *
 * Wat dat bewijst, en wat niet: dat dezelfde entiteit achter de sleutel en het
 * account zit. Verhuist het account, dan draagt het nieuwe dezelfde did:key, en
 * dat bewijst de continuiteit ook als de oude server weg of vijandig is -- een
 * Move kan dat niet, want die moet door de OUDE server ondertekend worden. Het
 * bewijst NIET dat elke post van jou is: een gecompromitteerde server tekent nog
 * steeds met zijn eigen sleutel.
 *
 * DE CRYPTOGRAFIE is Data Integrity met eddsa-jcs-2022 (W3C vc-di-eddsa), omdat
 * Mitra en streams dat controleren. Getoetst tegen de testvectoren uit B.3 van
 * die specificatie, zodat dit niet alleen het met zichzelf eens is.
 *
 * Puur, zonder database: de regels moeten te toetsen zijn zonder server.
 */
import crypto from 'crypto';

// ── base58btc (Bitcoin-alfabet), en multibase met het 'z'-voorvoegsel ──

const ALFABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const WAARDE = new Map([...ALFABET].map((c, i) => [c, i]));

export function base58Encode(bytes) {
  const b = Buffer.from(bytes);
  let nullen = 0;
  while (nullen < b.length && b[nullen] === 0) nullen++;
  let n = BigInt('0x' + (b.length ? b.toString('hex') : '0'));
  let uit = '';
  while (n > 0n) { uit = ALFABET[Number(n % 58n)] + uit; n /= 58n; }
  return '1'.repeat(nullen) + uit;
}

export function base58Decode(str) {
  if (typeof str !== 'string') return null;
  let nullen = 0;
  while (nullen < str.length && str[nullen] === '1') nullen++;
  let n = 0n;
  for (const c of str) {
    const v = WAARDE.get(c);
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(nullen), Buffer.from(hex, 'hex')]);
}

// ── JCS (RFC 8785) ─────────────────────────────────────────────────────
//
// RFC 8785 is precies om ECMAScript heen gebouwd: getallen en strings zoals
// JSON.stringify ze schrijft, sleutels op UTF-16-code-eenheden gesorteerd --
// wat Array.prototype.sort op strings al doet. In JavaScript is de canonieke
// vorm dus een gesorteerde JSON.stringify, en niets eigen.

export function jcs(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JCS: geen NaN of oneindig');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (typeof value === 'object') {
    const sleutels = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${sleutels.map((k) => `${JSON.stringify(k)}:${jcs(value[k])}`).join(',')}}`;
  }
  throw new Error(`JCS: ${typeof value} is geen JSON`);
}

// ── did:key voor Ed25519 ───────────────────────────────────────────────
//
// did:key:z<base58btc(0xed 0x01 || publieke sleutel van 32 bytes)>. Alleen
// Ed25519 (het "z6Mk"-begin): dat is wat eddsa-jcs-2022 kan controleren.

const ED25519_PUB = Buffer.from([0xed, 0x01]);
const ED25519_PRIV = Buffer.from([0x80, 0x26]);

export function didKeyFromPublicKey(raw) {
  const b = Buffer.from(raw);
  if (b.length !== 32) throw new Error('een Ed25519-sleutel is 32 bytes');
  return `did:key:z${base58Encode(Buffer.concat([ED25519_PUB, b]))}`;
}

/** De ruwe publieke sleutel achter een did:key, of null als het geen Ed25519-did:key is. */
export function publicKeyFromDidKey(did) {
  const m = /^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(did || ''));
  if (!m) return null;
  const b = base58Decode(m[1]);
  if (!b || b.length !== 34 || b[0] !== 0xed || b[1] !== 0x01) return null;
  return b.subarray(2);
}

/** Een multibase-geheime-sleutel (z3u2...) naar zijn zaad van 32 bytes. Voor de toetsen. */
export function seedFromSecretKeyMultibase(mb) {
  const b = typeof mb === 'string' && mb[0] === 'z' ? base58Decode(mb.slice(1)) : null;
  if (!b || b.length !== 34 || b[0] !== ED25519_PRIV[0] || b[1] !== ED25519_PRIV[1]) return null;
  return b.subarray(2);
}

const publicKeyObject = (raw) => crypto.createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk',
});
const privateKeyObject = (seed, raw) => crypto.createPrivateKey({
  key: {
    kty: 'OKP', crv: 'Ed25519',
    d: Buffer.from(seed).toString('base64url'),
    x: Buffer.from(raw).toString('base64url'),
  },
  format: 'jwk',
});

/** De publieke sleutel bij een zaad van 32 bytes. */
export function publicKeyFromSeed(seed) {
  // Node leidt de publieke sleutel af als je alleen `d` geeft via PKCS#8.
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]);
  const priv = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(priv).export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

// ── eddsa-jcs-2022 ────────────────────────────────────────────────────

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

/** De 64 bytes die ondertekend worden: hash(proofConfig) || hash(document). */
export function hashData(proofConfig, unsecured) {
  return Buffer.concat([sha256(jcs(proofConfig)), sha256(jcs(unsecured))]);
}

/**
 * Onderteken een document (vc-di-eddsa 3.3.1). De server doet dit nooit voor een
 * identiteitsbewijs; het staat hier voor de toetsen en om de andere kant te
 * kunnen nabootsen.
 */
export function signEddsaJcs2022(unsecured, seed, options) {
  const raw = publicKeyFromSeed(seed);
  const proofConfig = { ...options, type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022' };
  if (unsecured['@context'] !== undefined) proofConfig['@context'] = unsecured['@context'];
  const sig = crypto.sign(null, hashData(proofConfig, unsecured), privateKeyObject(seed, raw));
  return { ...unsecured, proof: { ...proofConfig, proofValue: `z${base58Encode(sig)}` } };
}

/**
 * Controleer een ondertekend document (vc-di-eddsa 3.3.2) met een ruwe publieke
 * sleutel. Geeft true of false; nooit een uitzondering voor kwade invoer.
 */
export function verifyEddsaJcs2022(secured, publicKeyRaw) {
  try {
    if (!secured || typeof secured !== 'object' || Array.isArray(secured)) return false;
    const { proof, ...unsecured } = secured;
    if (!proof || typeof proof !== 'object') return false;
    if (proof.type !== 'DataIntegrityProof' || proof.cryptosuite !== 'eddsa-jcs-2022') return false;
    const { proofValue, ...proofOptions } = proof;
    if (typeof proofValue !== 'string' || proofValue[0] !== 'z') return false;
    // "If proofOptions.@context exists": het document moet met precies die
    // contexten beginnen, in die volgorde, en krijgt ze dan voor het hashen.
    if (proofOptions['@context'] !== undefined) {
      const pc = [].concat(proofOptions['@context']);
      const dc = [].concat(unsecured['@context'] ?? []);
      if (pc.some((c, i) => jcs(c) !== jcs(dc[i]))) return false;
      unsecured['@context'] = proofOptions['@context'];
    }
    const sig = base58Decode(proofValue.slice(1));
    if (!sig || sig.length !== 64) return false;
    return crypto.verify(null, hashData(proofOptions, unsecured), publicKeyObject(publicKeyRaw), sig);
  } catch {
    return false;
  }
}

// ── FEP-c390: de verklaring ──────────────────────────────────────────

/** Groter dan dit is geen identiteitsverklaring meer maar iets anders. */
export const MAX_STATEMENT_BYTES = 4096;

/**
 * Is dit een geldige verklaring voor deze actor? Geeft `{ ok: true, subject }`
 * of `{ ok: false, error }`. De volgorde van de controles is de volgorde van
 * FEP-c390, en elke weigering zegt welke regel het was.
 */
export function checkStatement(stmt, actorId) {
  if (!stmt || typeof stmt !== 'object' || Array.isArray(stmt)) return { ok: false, error: 'not_an_object' };
  let grootte = 0;
  try { grootte = Buffer.byteLength(JSON.stringify(stmt), 'utf8'); } catch { return { ok: false, error: 'not_json' }; }
  if (grootte > MAX_STATEMENT_BYTES) return { ok: false, error: 'too_large' };
  if (stmt.type !== 'VerifiableIdentityStatement') return { ok: false, error: 'wrong_type' };
  if (stmt.alsoKnownAs !== actorId) return { ok: false, error: 'alsoKnownAs_is_not_this_actor' };
  const raw = publicKeyFromDidKey(stmt.subject);
  if (!raw) return { ok: false, error: 'subject_is_not_an_ed25519_did_key' };
  const proof = stmt.proof;
  if (!proof || typeof proof !== 'object') return { ok: false, error: 'no_proof' };
  // c390: "verificationMethod MUST match subject". Precies, zonder #-fragment.
  if (proof.verificationMethod !== stmt.subject) return { ok: false, error: 'verificationMethod_is_not_subject' };
  if (proof.proofPurpose !== 'assertionMethod') return { ok: false, error: 'wrong_proofPurpose' };
  if (!verifyEddsaJcs2022(stmt, raw)) return { ok: false, error: 'bad_signature' };
  return { ok: true, subject: stmt.subject };
}

/** De contexten die een verklaring zelf draagt. Zo hoeft de actor er geen bij,
 *  waar did/v1 en data-integrity/v1 met hun beschermde termen met Klonkts eigen
 *  inline context zouden kunnen botsen. */
export const STATEMENT_CONTEXT = [
  'https://www.w3.org/ns/activitystreams',
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/data-integrity/v1',
  'https://w3id.org/fep/c390',
];
