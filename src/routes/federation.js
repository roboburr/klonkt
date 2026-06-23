// routes/federation.js — public Cirkels endpoints (v1, publication side).
//
//   GET /.klonkt/actor.json   — ActivityStreams actor + Ed25519 public key
//   GET /.klonkt/outbox.json  — public posts as AS Create objects,
//                               signed via the Klonkt-Signature header
//
// Site-agnostic and unauthenticated — read-only. See docs/cirkels-v1-spec.md.

import express from 'express';
import { buildActor, buildOutbox, signBody, KLONKT_PROTO, MIN_PROTO } from '../services/CircleFederation.js';
import { getTenancy } from '../services/SettingsService.js';

const router = express.Router();

function baseUrl(req) {
  const b = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return b.replace(/\/+$/, '');
}

// The proto the consumer claims to be running (from their request header), or 0.
function consumerProto(req) {
  return parseInt(req.get('Klonkt-Proto') || '0', 10) || 0;
}

router.get('/.klonkt/actor.json', (req, res) => {
  // Circles = solo-to-solo; hubs do not publish a federation actor.
  if (getTenancy() === 'hub') return res.status(404).type('text/plain').send('Niet beschikbaar in hub-modus');
  // We ALWAYS serve the actor (including to older consumers) so they can read our
  // proto and show a clean "update required" message.
  const body = JSON.stringify(buildActor(baseUrl(req)), null, 2);
  res.type('application/activity+json; charset=utf-8');
  res.set('Klonkt-Proto', String(KLONKT_PROTO));
  res.set('Cache-Control', 'public, max-age=300');
  res.send(body);
});

router.get('/.klonkt/outbox.json', (req, res) => {
  if (getTenancy() === 'hub') return res.status(404).type('text/plain').send('Niet beschikbaar in hub-modus');
  res.set('Klonkt-Proto', String(KLONKT_PROTO));
  // Consumer too old? Reject with 426 Upgrade Required (the crypto binding already
  // excludes them; this gives an explicit, readable signal). proto 0 = no header
  // (e.g. a browser/curl) → allow, they won't verify anyway.
  const cp = consumerProto(req);
  if (cp && cp < MIN_PROTO) {
    return res.status(426).type('text/plain')
      .send(`Upgrade Required: deze cirkel draait proto ${KLONKT_PROTO}; jouw Klonkt (proto ${cp}) is te oud.`);
  }
  const body = JSON.stringify(buildOutbox(baseUrl(req)), null, 2);
  res.type('application/activity+json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Klonkt-Signature', `ed25519=${signBody(body)}`);
  res.send(body);
});

export default router;
