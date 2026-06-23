// Global app settings (key/value, cached). Primarily used for the tenancy mode.
//
//   tenancy = 'solo'  -> exactly one site (the primary/owner site)
//   tenancy = 'hub'   -> main site (company) + /user/, admin assigns Klonkt sites
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
  const v = getSetting('tenancy', 'solo');
  return v === 'hub' ? 'hub' : v === 'circle' ? 'circle' : 'solo';
}

export function setTenancy(mode) {
  const m = (mode === 'hub' || mode === 'circle') ? mode : 'solo';
  setSetting('tenancy', m);
}
