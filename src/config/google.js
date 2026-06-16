// Google OAuth2 voor LUISTERAARS (reageren). Per-instance: de self-hoster zet
// z'n EIGEN Google-client. Zo hangt elke site aan z'n eigen Google Cloud project
// — geen centrale afhankelijkheid, geen gedeelde aansprakelijkheid.
//
// Config-bron (in deze volgorde): app_settings (ingesteld via Beheer → Instellingen),
// anders de env-vars. Niet ingesteld → geen "Login met Google"-knop; de rest van
// de site werkt door. Google-login geeft NOOIT beheerrechten.
//
// De redirect-URI wordt afgeleid van PUBLIC_BASE_URL (<base>/auth/google/callback),
// of expliciet via GOOGLE_REDIRECT_URI. Die exacte URL moet in Google Cloud staan.

import { getSetting } from '../services/SettingsService.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Dynamisch lezen (UI-wijziging werkt zonder herstart). app_settings wint, env = fallback.
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

export function currentClientId() { return clientId(); } // niet-geheim, voor het formulier
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
  if (!r.ok) throw new Error(`Google token-exchange faalde: ${r.status}`);
  return r.json(); // { access_token, id_token, ... }
}

// Returns { sub, email, email_verified, name, picture }.
export async function fetchUserinfo(accessToken) {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Google userinfo faalde: ${r.status}`);
  return r.json();
}
