/**
 * Publieke wijzigingen-/release-pagina.
 *
 * GET /changelog  -> rendert CHANGELOG.md (de bron van waarheid voor releases).
 *
 * De app-versie (footer, package.json) is bewust losgekoppeld van de
 * cirkel-federatie-proto (KLONKT_PROTO): een versie-bump is cosmetisch en raakt
 * de federatie niet. We tonen de proto hier expliciet zodat per release zichtbaar
 * is met welke federatie-versie deze instance praat (cirkels = lockstep per proto).
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderPage } from '../middleware/render.js';
import { MarkdownService } from '../services/MarkdownService.js';
import { KLONKT_PROTO } from '../services/CircleFederation.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = path.join(__dirname, '..', '..', 'CHANGELOG.md');

router.get('/changelog', (req, res) => {
  let html;
  try {
    html = MarkdownService.render(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
  } catch {
    html = '<p>Geen wijzigingenoverzicht beschikbaar.</p>';
  }
  renderPage(req, res, 'pages/changelog', {
    pageTitle: 'Wijzigingen',
    bodyClass: 'on-changelog',
    changelogHtml: html,
    proto: KLONKT_PROTO,
  });
});

export default router;
