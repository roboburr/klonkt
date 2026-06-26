/**
 * Admin: global settings.
 *  - tenancy mode (Solo/Hub)
 *  - hub branding (name/tagline/intro/hero of the generic hub home page)
 *
 * GET  /admin/settings   -> show current settings
 * POST /admin/settings   -> save (god-only). Also accepts an uploaded
 *                           hero image (multipart); an upload wins over the
 *                           URL text field. Without an upload the URL field is leading.
 *
 * The hub page is generic (belonging to no user); this branding lives in
 * global settings, not in a site.
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import { renderPage } from '../middleware/render.js';
import { requireGod } from '../middleware/auth.js';
import { getTenancy, setTenancy, getSetting, setSetting } from '../services/SettingsService.js';
import { SUPPORTED } from '../services/i18n.js';
import { mailerStatus, sendMail } from '../config/mailer.js';
import { entitlementStatus, premiumUnlocked } from '../services/PatreonService.js';
import { toWebp } from '../services/ImageWebpService.js';

const router = express.Router();

// Hero dark overlay: percentage 0-100 (0 = no overlay, 100 = fully black).
// Default 45 = the old hard-coded value, so existing hubs don't change appearance.
function clampOverlay(raw) {
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 45;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Hero uploads land in storage/media/hero → accessible as /media/hero/<file>
// (the /media static handler serves storage/media). Same model as avatars.
const HERO_DIR = path.resolve(
  process.env.HERO_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'hero')
);
fs.mkdirSync(HERO_DIR, { recursive: true });

// Only raster formats for upload. SVG is intentionally NOT allowed via upload
// (raw SVG can contain scripts → stored-XSS when opened directly); an SVG hero
// can still be set via the URL field (like the bundled demo placeholder).
const ALLOWED_HERO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MAX_HERO_BYTES = 5 * 1024 * 1024;

const heroUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, HERO_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: MAX_HERO_BYTES },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_HERO_EXT.has(ext)) {
      return cb(new Error('Hero-afbeelding moet jpg/png/webp/gif zijn'));
    }
    cb(null, true);
  },
});

router.get('/', requireGod, (req, res) => {
  renderPage(req, res, 'pages/admin-settings', {
    pageTitle: 'Instellingen',
    bodyClass: 'on-admin',
    tenancy: getTenancy(),
    hubTitle: getSetting('hub_title') || '',
    hubTagline: getSetting('hub_tagline') || '',
    hubIntro: getSetting('hub_intro') || '',
    hubHeroImage: getSetting('hub_hero_image') || '',
    hubHeroOverlay: clampOverlay(getSetting('hub_hero_overlay')),
    defaultLang: getSetting('default_lang') || '',
    premium: entitlementStatus(),
    smtp: mailerStatus(),
    footerNewsletter: getSetting('footer_newsletter') === '1',
    apEnabledSetting: getSetting('ap_enabled', '1') !== '0',
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

router.post('/', requireGod, (req, res) => {
  // multer.single processes multipart (hub branding form). For a plain
  // urlencoded POST (tenancy form) multer does nothing and req.body stays intact.
  heroUpload.single('hub_hero_file')(req, res, (err) => {
    if (err) {
      return res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
    }

    if (typeof req.body.tenancy !== 'undefined') {
      // Hub mode is removed → setTenancy only accepts solo | circle (coerces the rest).
      setTenancy(req.body.tenancy);
    }
    if (typeof req.body.default_lang !== 'undefined') {
      // Default language for visitors (empty = follow env/browser). Validated against NL/EN/DE.
      const dl = (req.body.default_lang || '').toString().toLowerCase();
      setSetting('default_lang', SUPPORTED.includes(dl) ? dl : '');
    }
    if (typeof req.body.timezone !== 'undefined') {
      // Site timezone (IANA, e.g. Europe/Amsterdam). Empty = server default (UTC).
      // Validate with Intl so a nonsense value never breaks date rendering.
      const tz = (req.body.timezone || '').toString().trim();
      let valid = '';
      if (tz) { try { Intl.DateTimeFormat('en-US', { timeZone: tz }); valid = tz; } catch { valid = ''; } }
      setSetting('timezone', valid);
    }
    if (typeof req.body.hub_title !== 'undefined') {
      setSetting('hub_title', (req.body.hub_title || '').toString().slice(0, 80).trim());
    }
    if (typeof req.body.hub_tagline !== 'undefined') {
      setSetting('hub_tagline', (req.body.hub_tagline || '').toString().slice(0, 120).trim());
    }
    if (typeof req.body.hub_intro !== 'undefined') {
      setSetting('hub_intro', (req.body.hub_intro || '').toString().slice(0, 400).trim());
    }

    // Hero: an uploaded image wins; otherwise the URL text field.
    if (req.file) {
      const newUrl = `/media/hero/${toWebp(req.file)}`;
      // Clean up a previously uploaded hero (only if it came from our hero dir).
      const old = getSetting('hub_hero_image') || '';
      if (old.startsWith('/media/hero/')) {
        try { fs.unlinkSync(path.join(HERO_DIR, path.basename(old))); } catch {}
      }
      setSetting('hub_hero_image', newUrl);
    } else if (typeof req.body.hub_hero_image !== 'undefined') {
      setSetting('hub_hero_image', (req.body.hub_hero_image || '').toString().slice(0, 300).trim());
    }

    if (typeof req.body.hub_hero_overlay !== 'undefined') {
      setSetting('hub_hero_overlay', String(clampOverlay(req.body.hub_hero_overlay)));
    }

    res.redirect('/admin/settings?success=' + encodeURIComponent('Opgeslagen'));
  });
});

// ── SMTP / e-mail-instellingen ────────────────────────────────────
router.post('/smtp', requireGod, (req, res) => {
  const b = req.body || {};
  if (b.clear === '1') {
    ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from'].forEach((k) => setSetting(k, ''));
    return res.redirect('/admin/settings?success=' + encodeURIComponent('SMTP-instellingen gewist'));
  }
  setSetting('smtp_host', (b.smtp_host || '').toString().trim());
  setSetting('smtp_port', (b.smtp_port || '').toString().trim());
  setSetting('smtp_user', (b.smtp_user || '').toString().trim());
  setSetting('smtp_from', (b.smtp_from || '').toString().trim());
  // Only overwrite the password if a new value was entered.
  const pass = (b.smtp_pass || '').toString();
  if (pass) setSetting('smtp_pass', pass);
  res.redirect('/admin/settings?success=' + encodeURIComponent('SMTP-instellingen opgeslagen'));
});

// Newsletter sign-up in the footer on/off.
router.post('/footer', requireGod, (req, res) => {
  setSetting('footer_newsletter', req.body.footer_newsletter ? '1' : '0');
  res.redirect('/admin/settings?success=' + encodeURIComponent('Footer-instelling opgeslagen'));
});

// Site mode: Solo (ap off → no federation, no comments) or Circles (ap on).
// Driven by a radio (mode=solo|cirkels); legacy ap_enabled checkbox still accepted.
router.post('/ap', requireGod, (req, res) => {
  let enabled;
  if (typeof req.body.mode !== 'undefined') enabled = req.body.mode === 'solo' ? '0' : '1';
  else enabled = req.body.ap_enabled ? '1' : '0';
  setSetting('ap_enabled', enabled);
  res.redirect('/admin/settings?success=' + encodeURIComponent('Modus opgeslagen'));
});

// Send a test email to a specified address (or the logged-in user).
router.post('/smtp/test', requireGod, async (req, res) => {
  const to = ((req.body && req.body.to) || (req.session.user && req.session.user.email) || '').toString().trim();
  if (!to || to.indexOf('@') === -1) {
    return res.redirect('/admin/settings?error=' + encodeURIComponent('Geef een geldig test-e-mailadres op.'));
  }
  try {
    await sendMail({
      to,
      subject: 'Klonkt — SMTP-test',
      text: 'Gelukt! Je SMTP-instellingen werken. Dit is een testbericht van je Klonkt-site.',
      html: '<p>Gelukt! Je <strong>SMTP-instellingen werken</strong>. Dit is een testbericht van je Klonkt-site.</p>',
    });
    res.redirect('/admin/settings?success=' + encodeURIComponent('Testmail verstuurd naar ' + to));
  } catch (e) {
    res.redirect('/admin/settings?error=' + encodeURIComponent('Testmail mislukt: ' + (e.message || e)));
  }
});

export default router;
