/**
 * Public changelog / release page.
 *
 * GET /changelog  -> renders the changelog in the visitor's language:
 *   CHANGELOG.<lang>.md if a translation exists, else CHANGELOG.md (English base).
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderPage } from '../middleware/render.js';
import { MarkdownService } from '../services/MarkdownService.js';
import { resolveLang, t } from '../services/i18n.js';
import { getSetting } from '../services/SettingsService.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

router.get('/changelog', (req, res) => {
  const lang = resolveLang(req, {
    userLang: req.session && req.session.user && req.session.user.lang,
    defaultLang: getSetting('default_lang'),
  });
  // Visitor's language if a translation exists, else the English base.
  const files = [path.join(ROOT, `CHANGELOG.${lang}.md`), path.join(ROOT, 'CHANGELOG.md')];
  let html = '';
  for (const f of files) {
    try { html = MarkdownService.render(fs.readFileSync(f, 'utf8')); break; } catch { /* try next */ }
  }
  if (!html) html = `<p>${t(lang, 'changelog.empty')}</p>`;
  renderPage(req, res, 'pages/changelog', {
    pageTitle: t(lang, 'changelog.title'),
    bodyClass: 'on-changelog',
    changelogHtml: html,
  });
});

export default router;
