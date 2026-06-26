// Global app settings (key/value, cached). Primarily used for the tenancy mode.
//
//   tenancy = 'solo'   -> exactly one site (the primary/owner site)
//   tenancy = 'circle' -> solo site that federates with other solo Klonkt sites
//
// HUB MODE IS REMOVED (2026-06-24): multi-artist-per-domain was dropped in favour
// of solo + Cirkels. getTenancy() coerces any legacy 'hub' value to 'solo' so all
// the old `tenancy === 'hub'` branches are unreachable; the hub code is being
// deleted incrementally.
//
// The cache is updated immediately on setSetting, so a toggle in admin
// takes effect live without a restart.

import db from '../config/database.js';

let _cache = null;

function load() {
  if (!_cache) {
    _cache = {};
    for (const r of db.prepare('SELECT key, value FROM app_settings').all()) {
      _cache[r.key] = r.value;
    }
  }
  return _cache;
}

export function getSetting(key, fallback = null) {
  const v = load()[key];
  return v === undefined ? fallback : v;
}

export function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(key, String(value));
  if (_cache) _cache[key] = String(value);
}

export function getTenancy() {
  // Tenancy is retired: 'hub' and 'circle' were both removed. Every site is
  // 'solo'. Cirkels are now an ActivityPub feature (auto-boost), not a mode.
  return 'solo';
}

export function setTenancy() {
  setSetting('tenancy', 'solo');
}

// ActivityPub / fediverse federation. ON by default. '0' = off: the site does
// not federate, /ap/* is gone, and the "from the fediverse" reactions disappear
// — which (since native comments were removed) means no comments at all.
export function apEnabled() {
  return getSetting('ap_enabled', '1') !== '0';
}
