import { v4 as uuid } from 'uuid';
import db from '../config/database.js';

// A Klonkt instance should ALWAYS have a primary site — it carries the identity
// (title, theme, profile) and is the anchor point in solo/hub/circle mode.
// The register flow already creates one, but an admin created via a script
// (or an empty sites table for any reason) left the instance without a site:
// no settings, dashboard would crash.
//
// This helper runs at boot (and is idempotent): as soon as there is an admin
// but no site yet, it creates a default site owned by the first god/admin.
// Tenancy-agnostic — applies to solo, hub, and circle.

function defaultTitle() {
  try {
    const base = process.env.PUBLIC_BASE_URL;
    if (base) {
      const host = new URL(base).hostname.replace(/^www\./, '');
      const label = host.split('.')[0];
      if (label) return label.charAt(0).toUpperCase() + label.slice(1);
    }
  } catch { /* fall back to generic */ }
  return 'Mijn site';
}

export function ensurePrimarySite() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c;
  if (count > 0) return null; // a site already exists — nothing to do

  const owner = db.prepare(
    "SELECT id FROM users WHERE role IN ('god','admin') ORDER BY created_at LIMIT 1"
  ).get();
  if (!owner) return null; // no admin yet -> no owner, nothing to create

  const siteId = uuid();
  const slug = 'main'; // not reserved; in solo mode the primary site is always pinned anyway
  db.prepare(`
    INSERT INTO sites (
      id, slug, title, description, tagline, owner_id,
      language, palette, accent, profile_photo,
      is_public, robots_index, require_login_to_comment, enable_audio_player,
      feed_view_default, is_primary
    ) VALUES (?, ?, ?, '', '', ?, 'en', 'klonkt', '#e8b04b', NULL, 1, 1, 1, 1, 'grid', 1)
  `).run(siteId, slug, defaultTitle(), owner.id);

  // site_members-entry zodat de owner door canAdminSite-checks komt.
  db.prepare(
    "INSERT INTO site_members (site_id, user_id, role) VALUES (?, ?, 'admin')"
  ).run(siteId, owner.id);

  console.log(`[ensurePrimarySite] standaard-site '${slug}' aangemaakt (owner ${owner.id})`);
  return { siteId, slug };
}
