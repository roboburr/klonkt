/**
 * Admin: globale instellingen.
 *  - tenancy-modus (Solo/Hub)
 *  - hub-branding (naam/tagline/intro/hero van de generieke hub-hoofdpagina)
 *
 * GET  /admin/settings   -> toon huidige instellingen
 * POST /admin/settings   -> sla op (god-only). Accepteert nu ook een geuploade
 *                           hero-afbeelding (multipart); een upload wint van het
 *                           URL-tekstveld. Zonder upload blijft het URL-veld leidend.
 *
 * De hub-pagina is generiek (van geen enkele user); deze branding leeft in
 * globale settings, niet in een site.
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
import { mailerStatus, sendMail } from '../config/mailer.js';
import { entitlementStatus, premiumUnlocked } from '../services/PatreonService.js';
import { googleConfigured, redirectUri, currentClientId, clientSecretSet } from '../config/google.js';

const router = express.Router();

// Hero dark-overlay: percentage 0-100 (0 = geen overlay, 100 = volledig zwart).
// Default 45 = de oude hardgecodeerde waarde, zodat bestaande hubs niet wijzigen.
function clampOverlay(raw) {
  const v = parseInt(raw, 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 45;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Hero-uploads landen in storage/media/hero → bereikbaar als /media/hero/<file>
// (de /media static handler serveert storage/media). Zelfde model als avatars.
const HERO_DIR = path.resolve(
  process.env.HERO_PATH || path.join(__dirname, '..', '..', 'storage', 'media', 'hero')
);
fs.mkdirSync(HERO_DIR, { recursive: true });

// Alleen raster-formaten voor de upload. SVG mag bewust NIET via upload (raw
// SVG kan script bevatten → opgeslagen-XSS bij direct openen); een SVG-hero kan
// nog steeds via het URL-veld (zoals de meegeleverde demo-placeholder).
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
    premium: entitlementStatus(),
    google: {
      configured: googleConfigured(),
      redirectUri: redirectUri(),
      clientId: currentClientId(),
      secretSet: clientSecretSet(),
    },
    smtp: mailerStatus(),
    footerNewsletter: getSetting('footer_newsletter') === '1',
    success: req.query.success || null,
    error: req.query.error || null,
  });
});

router.post('/', requireGod, (req, res) => {
  // multer.single verwerkt multipart (hub-branding form). Bij een gewone
  // urlencoded POST (tenancy-form) doet multer niets en blijft req.body intact.
  heroUpload.single('hub_hero_file')(req, res, (err) => {
    if (err) {
      return res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
    }

    if (typeof req.body.tenancy !== 'undefined') {
      // Hub-modus is een premium-feature: alleen naar hub schakelen als premium
      // ontgrendeld is (premium-laag uit = vrij; aan = Patreon vereist). Al-hub
      // blijven mag altijd, zodat een instance nooit vastloopt.
      if (req.body.tenancy === 'hub' && !premiumUnlocked() && getTenancy() !== 'hub') {
        return res.redirect('/admin/settings?error=' + encodeURIComponent('Hub-modus is een premium-functie — koppel Patreon in Beheer → Instellingen.'));
      }
      setTenancy(req.body.tenancy); // valideert naar solo | hub | circle
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

    // Hero: een geüploade afbeelding wint; anders het URL-tekstveld.
    if (req.file) {
      const newUrl = `/media/hero/${req.file.filename}`;
      // Ruim een vorige geüploade hero op (alleen als die uit onze hero-map kwam).
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

// Google-login (luisteraars) configureren — Client ID + Secret in app_settings.
// De redirect-URI leiden we af van PUBLIC_BASE_URL (zie config/google.js).
router.post('/google', requireGod, (req, res) => {
  if (req.body.clear === '1') {
    setSetting('google_client_id', '');
    setSetting('google_client_secret', '');
    return res.redirect('/admin/settings?success=' + encodeURIComponent('Google-login losgekoppeld'));
  }
  setSetting('google_client_id', (req.body.google_client_id || '').toString().trim());
  // Secret alleen overschrijven als er een nieuwe waarde is ingevoerd (leeg = laat staan).
  const secret = (req.body.google_client_secret || '').toString().trim();
  if (secret) setSetting('google_client_secret', secret);
  res.redirect('/admin/settings?success=' + encodeURIComponent('Google-login opgeslagen'));
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
  // Wachtwoord alleen overschrijven als er een nieuwe waarde is ingevoerd.
  const pass = (b.smtp_pass || '').toString();
  if (pass) setSetting('smtp_pass', pass);
  res.redirect('/admin/settings?success=' + encodeURIComponent('SMTP-instellingen opgeslagen'));
});

// Nieuwsbrief-aanmelding in de footer aan/uit.
router.post('/footer', requireGod, (req, res) => {
  setSetting('footer_newsletter', req.body.footer_newsletter ? '1' : '0');
  res.redirect('/admin/settings?success=' + encodeURIComponent('Footer-instelling opgeslagen'));
});

// Testmail sturen naar een opgegeven adres (of de ingelogde gebruiker).
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
