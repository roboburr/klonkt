// Google OAuth2 (per-instance). Raw via de ingebouwde fetch — geen passport-dep.
// Config via env (per instance, in .env):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   GOOGLE_REDIRECT_URI = https://<dit-domein>/auth/google/callback
//   ADMIN_EMAIL         = de Google-mail die owner/admin (god) is op deze instance
// Niet geconfigureerd? Dan booten we gewoon door; /auth/google meldt netjes
// "nog niet geconfigureerd" i.p.v. te crashen.

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function googleConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI);
}

export function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${p.toString()}`;
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`Google token-exchange faalde: ${r.status} ${await r.text().catch(() => '')}`);
  return r.json(); // { access_token, id_token, ... }
}

// Returns { sub, email, email_verified, name, picture }.
export async function fetchUserinfo(accessToken) {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Google userinfo faalde: ${r.status}`);
  return r.json();
}
