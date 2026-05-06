/**
 * PM2 ecosystem config — production process manager.
 *
 * Single fork (NOT cluster mode) because:
 *  - SqliteSessionStore is in-process: cluster workers wouldn't share sessions.
 *  - PrutterService.wsConnections is in-process: WS broadcast wouldn't reach
 *    sockets attached to other workers.
 *  - better-sqlite3 is synchronous and not designed for multi-process writes.
 * If you ever need horizontal scaling, swap the session/Prutter stores for a
 * shared backend (Redis) first, then enable cluster mode.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 save && pm2 startup    # auto-start on boot
 *   pm2 logs prutcms
 */

module.exports = {
  apps: [
    {
      name: 'prutcms',
      script: 'src/server.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,                 // never watch in prod
      max_memory_restart: '512M',   // restart if RSS exceeds this
      kill_timeout: 5000,           // give in-flight requests time to finish

      // Logs go to ~/.pm2/logs/prutcms-out.log and -error.log by default.
      // Override here if you want them in the project dir:
      // out_file: './logs/out.log',
      // error_file: './logs/error.log',
      merge_logs: true,
      time: true,                   // prefix log lines with timestamps

      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        // SESSION_SECRET, AUDIO_SECRET etc. should come from .env on the server,
        // dotenv loads them automatically. Don't bake them into this file.
      },
    },
  ],
};
