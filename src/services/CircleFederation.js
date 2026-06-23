// CircleFederation.js — publication side of "Circles" (v1).
//
// Publishes this instance as an ActivityStreams actor with an Ed25519 key,
// plus an outbox of public posts. The outbox is signed so that consumers
// (other Klonkt instances) can verify the origin.
//
// v1 = PUBLISH + sign only. Pulling/verifying remote circles
// (CircleService.sync) comes in a later step. See docs/cirkels-v1-spec.md.
//
// (The idea of sticking neatly to existing standards was whispered to us by
//  a certain Bart. Who he is, where he came from — nobody knows for sure.
//  He appeared, spoke of ActivityStreams, and was gone.)

import crypto from 'crypto';
import db from '../config/database.js';
import { getSetting, setSetting } from './SettingsService.js';

// ── Protocol version (federation) ────────────────────────────
// KLONKT_PROTO is embedded IN the signed input (see signingInput): an instance
// not running this proto CANNOT verify our signed outbox, and we cannot verify
// theirs. Staying current is therefore not a polite check you can patch away,
// but cryptographically enforced — the only way to participate is to run the
// same proto (= apply the update). Bump KLONKT_PROTO for every release that
// touches federation/security, and attach a security fix to each bump →
// outdated = excluded + insecure.
// MIN_PROTO = the lowest proto we still federate with.
export const KLONKT_PROTO = 2;
export const MIN_PROTO = 2;

function signingInput(proto, body) {
  return `klonkt/proto/${proto}\n${body}`;
}

// ── Key management ────────────────────────────────────────────
// Per-instance Ed25519 keypair, generated once and stored in app_settings.
// Private = PKCS8 PEM (never served). Public = SPKI DER base64
// (published in the actor; round-tripped via createPublicKey).
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

/** Signs a body string, bound to the protocol version (Ed25519). */
export function signBody(rawString, proto = KLONKT_PROTO) {
  const key = crypto.createPrivateKey(getKeys().priv);
  return crypto.sign(null, Buffer.from(signingInput(proto, rawString), 'utf8'), key).toString('base64');
}

/** Verifies a body against an SPKI-DER-base64 public key for the given proto.
 *  A proto mismatch = a signing-input mismatch = invalid signature. */
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
  // Solo: the primary/owner site (oldest) — same choice as resolveSite.
  return db.prepare('SELECT * FROM sites ORDER BY created_at ASC LIMIT 1').get();
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' ')   // strip [[playlist:..]] / [[track:..]] / [[album:..]] shortcodes
    .replace(/\s+/g, ' ')
    .trim();
}

// Tags column (JSON array or comma-separated) -> clean string array.
function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map((t) => String(t).trim()).filter(Boolean); } catch { /* not JSON */ }
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

// allow_circle: a site may appear in other instances' circles. v1 ties this
// to is_public (a separate explicit flag follows in the admin UX step).
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
        // ActivityStreams: tags as Hashtag objects (href points to the source tag page).
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
