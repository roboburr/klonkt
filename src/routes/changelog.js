/**
 * Public changelog / release page.
 *
 * GET /changelog  -> renders CHANGELOG.md (the source of truth for releases).
 *
 * The app version (footer, package.json) is intentionally decoupled from the
 * circle federation proto (KLONKT_PROTO): a version bump is cosmetic and does not
 * affect federation. We show the proto here explicitly so that each release
 * makes visible which federation version this instance speaks (circles = lockstep per proto).
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
