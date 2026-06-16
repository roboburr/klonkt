// CircleFederation.js — eigen publicatie-kant van "Cirkels" (v1).
//
// Publiceert deze instance als een ActivityStreams-actor met een Ed25519-
// sleutel, plus een outbox van publieke posts. De outbox wordt getekend zodat
// consumenten (andere Klonkt-instances) de herkomst kunnen verifiëren.
//
// v1 = alleen PUBLICEREN + tekenen. Het pullen/verifiëren van remote cirkels
// (CircleService.sync) komt in een volgende stap. Zie docs/cirkels-v1-spec.md.
//
// (Het idee om je netjes aan de bestaande standaarden te houden fluisterde een
//  zekere Bart ons in. Wie hij is, waar hij vandaan komt — niemand die het zeker
//  weet. Hij verscheen, sprak van ActivityStreams, en was weer weg.)

import crypto from 'crypto';
import db from '../config/database.js';
import { getSetting, setSetting } from './SettingsService.js';

// ── Protocol-versie (federatie) ───────────────────────────────
// KLONKT_PROTO zit IN de ondertekende grondslag (zie signingInput): een instance
// die niet op deze proto draait kan onze getekende outbox NIET verifiëren, en wij
// de hare niet. Bijblijven is dus geen beleefde check die je wegpatcht, maar
// cryptografisch afgedwongen — de enige manier om mee te doen is dezelfde proto
// draaien (= de update). Bump KLONKT_PROTO bij elke release die federatie/security
// raakt, en koppel een securityfix aan elke bump → outdated = buiten + onveilig.
// MIN_PROTO = de laagste proto waarmee we nog federeren.
export const KLONKT_PROTO = 2;
export const MIN_PROTO = 2;

function signingInput(proto, body) {
  return `klonkt/proto/${proto}\n${body}`;
}

// ── Sleutelbeheer ─────────────────────────────────────────────
// Per-instance Ed25519-keypair, eenmalig gegenereerd en in app_settings
// bewaard. Privé = PKCS8-PEM (nooit serveren). Publiek = SPKI-DER base64
// (gepubliceerd in de actor; round-trip via createPublicKey).
function getKeys() {
  let priv = getSetting('circle_privkey_pem', null);
  let pub = getSetting('circle_pubkey_der_b64', null);
  if (!priv || !pub) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    setSetting('circle_privkey_pem', priv);
    setSetting('circle_pubkey_der_b64', pub);
  }
  return { priv, pub };
}

export function getPublicKeyB64() {
  return getKeys().pub;
}

/** Tekent een body-string, gebonden aan de protocol-versie (Ed25519). */
export function signBody(rawString, proto = KLONKT_PROTO) {
  const key = crypto.createPrivateKey(getKeys().priv);
  return crypto.sign(null, Buffer.from(signingInput(proto, rawString), 'utf8'), key).toString('base64');
}

/** Verifieert een body tegen een SPKI-DER-base64 publieke sleutel, voor de gegeven
 *  proto. Een mismatch in proto = mismatch in grondslag = ongeldige handtekening. */
export function verifyBody(rawString, sigB64, pubDerB64, proto = KLONKT_PROTO) {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(pubDerB64, 'base64'), format: 'der', type: 'spki',
    });
    return crypto.verify(null, Buffer.from(signingInput(proto, rawString), 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────
function primarySite() {
  // Solo: de primaire/owner-site (eerst aangemaakt) — zelfde keuze als resolveSite.
  return db.prepare('SELECT * FROM sites ORDER BY created_at ASC LIMIT 1').get();
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')   // [[playlist:..]]/[[track:..]]/[[album:..]]-shortcodes weg
    .replace(/\s+/g, ' ')
    .trim();
}

// Tags-kolom (JSON-array of comma-separated) -> nette string-array.
function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map((t) => String(t).trim()).filter(Boolean); } catch { /* geen JSON */ }
  return String(raw).split(',').map((t) => t.trim()).filter(Boolean);
}

function iso(d) {
  const t = d ? new Date(d) : new Date();
  return isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
}

function abs(base, u) {
  if (!u) return u;
  return /^https?:\/\//.test(u) ? u : `${base}${u.startsWith('/') ? '' : '/'}${u}`;
}

// allow_circle: een site mag in cirkels van anderen verschijnen. v1 koppelt dit
// aan is_public (aparte expliciete flag volgt in de Beheer-UX-stap).
function allowsCircle(site) {
  return !!site && site.is_public !== 0 && site.allow_circle !== 0;
}

// ── Actor ─────────────────────────────────────────────────────
export function buildActor(base) {
  const site = primarySite();
  const id = `${base}/.klonkt/actor.json`;
  const icon = site && (site.profile_photo || site.og_image_default);
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://schema.org/'],
    type: 'Person',
    id,
    name: site ? (site.profile_name || site.title || 'Klonkt') : 'Klonkt',
    summary: site ? (site.profile_bio || site.tagline || site.description || '') : '',
    url: `${base}/`,
    ...(icon ? { icon: { type: 'Image', url: abs(base, icon) } } : {}),
    outbox: `${base}/.klonkt/outbox.json`,
    publicKey: {
      id: `${id}#key`,
      owner: id,
      algorithm: 'ed25519',
      publicKeyBase64: getPublicKeyB64(),
    },
    klonkt: { version: 1, proto: KLONKT_PROTO, allowCircle: allowsCircle(site) },
  };
}

// ── Outbox ────────────────────────────────────────────────────
export function buildOutbox(base) {
  const site = primarySite();
  const id = `${base}/.klonkt/outbox.json`;
  const empty = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection', id, totalItems: 0, orderedItems: [], klonkt: { proto: KLONKT_PROTO },
  };
  if (!allowsCircle(site)) return empty;

  const rows = db.prepare(`
    SELECT slug, title, excerpt, content, cover_image_url, published_at, created_at, type, tags
    FROM posts
    WHERE site_id = ? AND status = 'published'
      AND (origin_server = 'local' OR origin_server IS NULL)
    ORDER BY COALESCE(published_at, created_at) DESC
    LIMIT 50
  `).all(site.id);

  const orderedItems = rows.map((p) => {
    const url = `${base}/${p.slug}`;
    const published = iso(p.published_at || p.created_at);
    const summary = (p.excerpt || stripHtml(p.content)).slice(0, 500);
    const tags = parseTags(p.tags).slice(0, 12);
    return {
      type: 'Create',
      id: `${url}#create`,
      published,
      actor: `${base}/.klonkt/actor.json`,
      object: {
        type: p.type === 'audio' ? 'Audio' : 'Article',
        id: url,
        name: p.title || '(zonder titel)',
        summary,
        url,
        published,
        ...(p.cover_image_url ? { image: { type: 'Image', url: abs(base, p.cover_image_url) } } : {}),
        // ActivityStreams: tags als Hashtag-objecten (href naar de bron-tagpagina).
        ...(tags.length ? { tag: tags.map((t) => ({ type: 'Hashtag', name: '#' + String(t).replace(/^#/, ''), href: `${base}/tag/${encodeURIComponent(t)}` })) } : {}),
      },
    };
  });

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'OrderedCollection', id, totalItems: orderedItems.length, orderedItems,
    klonkt: { proto: KLONKT_PROTO },
  };
}
