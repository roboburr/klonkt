// Global app settings (key/value, cached).
//
// One instance is one owner (Robins besluit, 31-7-2026). The old tenancy modes
// (hub = many artists on one domain, circle) are gone, code and all: the
// branches were already unreachable and have now been deleted.
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

// ActivityPub / fediverse federation. ON by default. '0' = off: the site does
// not federate, /ap/* is gone, and the "from the fediverse" reactions disappear
// — which (since native comments were removed) means no comments at all.
export function apEnabled() {
  return getSetting('ap_enabled', '1') !== '0';
}
