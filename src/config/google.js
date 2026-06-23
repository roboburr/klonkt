// Google OAuth2 for LISTENERS (commenting). Per-instance: each self-hoster sets
// their OWN Google client. This way every site is tied to its own Google Cloud
// project — no central dependency, no shared liability.
//
// Config source (in this order): app_settings (set via Admin → Settings),
// otherwise env vars. Not configured → no "Login with Google" button; the rest
// of the site keeps working. Google login NEVER grants admin rights.
//
// The redirect URI is derived from PUBLIC_BASE_URL (<base>/auth/google/callback),
// or explicitly via GOOGLE_REDIRECT_URI. That exact URL must be listed in Google Cloud.

import { getSetting } from '../services/SettingsService.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Read dynamically (UI changes take effect without a restart). app_settings wins, env = fallback.
function clientId() {
  return getSetting('google_client_id', '') || process.env.GOOGLE_CLIENT_ID || '';
}
function clientSecret() {
  return getSetting('google_client_secret', '') || process.env.GOOGLE_CLIENT_SECRET || '';
}
export function redirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}/auth/google/callback` : '';
}

export function currentClientId() { return clientId(); } // not secret, used for the settings form
export function clientSecretSet() { return !!clientSecret(); }
export function googleConfigured() {
  return !!(clientId() && clientSecret() && redirectUri());
}

export function authorizeUrl(state) {
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
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
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`Google token exchange failed: ${r.status}`);
  return r.json(); // { access_token, id_token, ... }
}

// Returns { sub, email, email_verified, name, picture }.
export async function fetchUserinfo(accessToken) {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Google userinfo failed: ${r.status}`);
  return r.json();
}
