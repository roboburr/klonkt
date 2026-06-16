// routes/federation.js — publieke Cirkels-endpoints (v1, publicatie-kant).
//
//   GET /.klonkt/actor.json   — ActivityStreams-actor + Ed25519-pubkey
//   GET /.klonkt/outbox.json  — publieke posts als AS Create-objecten,
//                               getekend via de Klonkt-Signature-header
//
// Site-agnostisch en zonder auth — alleen lezen. Zie docs/cirkels-v1-spec.md.

import express from 'express';
import { buildActor, buildOutbox, signBody, KLONKT_PROTO, MIN_PROTO } from '../services/CircleFederation.js';
import { getTenancy } from '../services/SettingsService.js';

const router = express.Router();

function baseUrl(req) {
  const b = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return b.replace(/\/+$/, '');
}

// De proto die de consument zegt te draaien (uit z'n request-header), of 0.
function consumerProto(req) {
  return parseInt(req.get('Klonkt-Proto') || '0', 10) || 0;
}

router.get('/.klonkt/actor.json', (req, res) => {
  // Cirkels = solo-naar-solo; hubs publiceren geen federatie-actor.
  if (getTenancy() === 'hub') return res.status(404).type('text/plain').send('Niet beschikbaar in hub-modus');
  // De actor serveren we ALTIJD (ook aan oudere consumenten) zodat zij onze proto
  // kunnen lezen en een nette "update vereist"-melding kunnen tonen.
  const body = JSON.stringify(buildActor(baseUrl(req)), null, 2);
  res.type('application/activity+json; charset=utf-8');
  res.set('Klonkt-Proto', String(KLONKT_PROTO));
  res.set('Cache-Control', 'public, max-age=300');
  res.send(body);
});

router.get('/.klonkt/outbox.json', (req, res) => {
  if (getTenancy() === 'hub') return res.status(404).type('text/plain').send('Niet beschikbaar in hub-modus');
  res.set('Klonkt-Proto', String(KLONKT_PROTO));
  // Te-oude consument? Weiger met 426 Upgrade Required (de crypto-binding sluit 'm
  // sowieso al uit; dit geeft een expliciet, leesbaar signaal). proto 0 = geen
  // header (bv. een browser/curl) → toestaan, die verifieert toch niet.
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
