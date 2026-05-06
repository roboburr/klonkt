/**
 * Persistent session store backed by the existing `sessions` table in
 * the SQLite DB. Survives `node --watch` restarts (no more "had to log in
 * again after every save").
 *
 * Schema (already in migrations/001-init.sql):
 *   sessions(sid TEXT PRIMARY KEY, data TEXT, expiresAt DATETIME)
 *
 * Implements the minimal express-session Store contract: get / set /
 * destroy / touch / length / clear / all. Periodic GC clears expired rows.
 */

import session from 'express-session';
import db from '../config/database.js';

const Store = session.Store;

export class SqliteSessionStore extends Store {
  constructor(options = {}) {
    super(options);
    // Periodic cleanup of expired rows. Default every 15 min.
    const intervalMs = options.cleanupIntervalMs ?? 15 * 60 * 1000;
    if (intervalMs > 0) {
      this._gcTimer = setInterval(() => this._gc(), intervalMs);
      // Don't keep the event loop alive just for GC.
      if (this._gcTimer.unref) this._gcTimer.unref();
    }

    // Prepared statements (faster than re-preparing per call)
    this._stmtGet = db.prepare('SELECT data, expiresAt FROM sessions WHERE sid = ?');
    this._stmtSet = db.prepare(
      'INSERT INTO sessions (sid, data, expiresAt) VALUES (?, ?, ?) ' +
      'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expiresAt = excluded.expiresAt'
    );
    this._stmtDestroy = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._stmtTouch = db.prepare('UPDATE sessions SET expiresAt = ? WHERE sid = ?');
    this._stmtCount = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE expiresAt > datetime('now')");
    this._stmtClear = db.prepare('DELETE FROM sessions');
    this._stmtAll = db.prepare("SELECT sid, data FROM sessions WHERE expiresAt > datetime('now')");
    this._stmtGc = db.prepare("DELETE FROM sessions WHERE expiresAt <= datetime('now')");
  }

  _gc() {
    try { this._stmtGc.run(); } catch (e) { /* swallow */ }
  }

  _expiryFor(sess) {
    // express-session sets sess.cookie.expires (Date) when maxAge is set.
    // Fallback to "now + 30 days" if missing (matches our cookie maxAge default).
    const exp = sess?.cookie?.expires
      ? new Date(sess.cookie.expires)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return exp.toISOString();
  }

  get(sid, cb) {
    try {
      const row = this._stmtGet.get(sid);
      if (!row) return cb(null, null);
      // Lazy expiry check (the periodic GC may not have run yet)
      if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
        this._stmtDestroy.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sess, cb) {
    try {
      this._stmtSet.run(sid, JSON.stringify(sess), this._expiryFor(sess));
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this._stmtDestroy.run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sess, cb) {
    try {
      this._stmtTouch.run(this._expiryFor(sess), sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  length(cb) {
    try { cb(null, this._stmtCount.get().c); } catch (e) { cb(e); }
  }

  clear(cb) {
    try { this._stmtClear.run(); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  all(cb) {
    try {
      const rows = this._stmtAll.all();
      const out = {};
      for (const r of rows) {
        try { out[r.sid] = JSON.parse(r.data); } catch (e) { /* skip */ }
      }
      cb(null, out);
    } catch (e) { cb(e); }
  }
}

export default SqliteSessionStore;
