import { v4 as uuid } from 'uuid';
import db from '../config/database.js';

// Een Klonkt-instance hoort ALTIJD een primaire site te hebben — die draagt de
// identiteit (titel, thema, profiel) en is het ankerpunt in solo/hub/circle.
// De register-flow maakt er al één aan, maar een via een script aangemaakte
// beheerder (of een om wat voor reden dan ook lege sites-tabel) liet de
// instance zonder site achter: geen instellingen, dashboard liep dood.
//
// Deze helper draait bij boot (en is idempotent): zodra er een beheerder is
// maar nog geen enkele site, maakt 'ie een standaard-site aan, eigendom van de
// eerste god/admin. Tenancy-onafhankelijk — geldt voor solo, hub én circle.

function defaultTitle() {
  try {
    const base = process.env.PUBLIC_BASE_URL;
    if (base) {
      const host = new URL(base).hostname.replace(/^www\./, '');
      const label = host.split('.')[0];
      if (label) return label.charAt(0).toUpperCase() + label.slice(1);
    }
  } catch { /* val terug op generiek */ }
  return 'Mijn site';
}

export function ensurePrimarySite() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
  if (count > 0) return null; // er is al een site — niets te doen

  const owner = db.prepare(
    "SELECT id FROM users WHERE role IN ('god','admin') ORDER BY created_at LIMIT 1"
  ).get();
  if (!owner) return null; // nog geen beheerder -> geen eigenaar, niets aanmaken

  const siteId = uuid();
  const slug = 'main'; // niet gereserveerd; in solo wordt de primaire site sowieso gepind
  db.prepare(`
    INSERT INTO sites (
      id, slug, title, description, tagline, owner_id,
      language, palette, accent, profile_photo,
      is_public, robots_index, require_login_to_comment, enable_audio_player,
      feed_view_default, comments_moderation_mode, is_primary
    ) VALUES (?, ?, ?, '', '', ?, 'nl', 'sage', '#c2410c', NULL, 1, 1, 0, 1, 'grid', 'moderate', 1)
  `).run(siteId, slug, defaultTitle(), owner.id);

  // site_members-entry zodat de owner door canAdminSite-checks komt.
  db.prepare(
    "INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')"
  ).run(siteId, owner.id);

  console.log(`[ensurePrimarySite] standaard-site '${slug}' aangemaakt (owner ${owner.id})`);
  return { siteId, slug };
}
