/**
 * Public changelog / release page.
 *
 * GET /changelog  -> renders CHANGELOG.md (the source of truth for releases).
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderPage } from '../middleware/render.js';
import { MarkdownService } from '../services/MarkdownService.js';

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
  });
});

export default router;
