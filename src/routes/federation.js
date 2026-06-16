// routes/federation.js — publieke Cirkels-endpoints (v1, publicatie-kant).
//
//   GET /.klonkt/actor.json   — ActivityStreams-actor + Ed25519-pubkey
//   GET /.klonkt/outbox.json  — publieke posts als AS Create-objecten,
//                               getekend via de Klonkt-Signature-header
//
// Site-agnostisch en zonder auth — alleen lezen. Zie docs/cirkels-v1-spec.md.

import express from 'express';
import { buildActor, buildOutbox, signBody } from '../services/CircleFederation.js';

const router = express.Router();

function baseUrl(req) {
  const b = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return b.replace(/\/+$/, '');
}

router.get('/.klonkt/actor.json', (req, res) => {
  const body = JSON.stringify(buildActor(baseUrl(req)), null, 2);
  res.type('application/activity+json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(body);
});

router.get('/.klonkt/outbox.json', (req, res) => {
  const body = JSON.stringify(buildOutbox(baseUrl(req)), null, 2);
  res.type('application/activity+json; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Klonkt-Signature', `ed25519=${signBody(body)}`);
  res.send(body);
});

export default router;
