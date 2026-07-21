// Paid posts (klonkt-demo-aki) slice 1: the site owner's own Patreon campaign.
// Stores client id/secret + the creator access/refresh token (encrypted) and a
// default price. Separate from PatreonService, which is Klonkt Premium's
// instance-level license flow and stays untouched.
import db from '../config/database.js';
import { encrypt, decrypt, cryptoBoxReady } from './CryptoBox.js';

const TOKEN_URL = 'https://www.patreon.com/api/oauth2/token';

// The owner's config, secrets decrypted. Returns null when unconfigured.
export function getOwnerConfig(siteId) {
  const row = db.prepare('SELECT * FROM paid_patreon WHERE site_id = ?').get(siteId);
  if (!row) return null;
  return {
    siteId: row.site_id,
    clientId: row.client_id || null,
    clientSecret: row.client_secret_enc ? safeDecrypt(row.client_secret_enc) : null,
    campaignId: row.campaign_id || null,
    accessToken: row.access_token_enc ? safeDecrypt(row.access_token_enc) : null,
    refreshToken: row.refresh_token_enc ? safeDecrypt(row.refresh_token_enc) : null,
    tokenExp: row.token_exp || 0,
    defaultMinCents: row.default_min_cents || 0,
  };
}

// Non-secret status for the admin screen (never returns tokens/secret).
export function ownerStatus(siteId) {
  const c = getOwnerConfig(siteId);
  if (!c) return { configured: false, connected: false, defaultMinCents: 0 };
  return {
    configured: !!(c.clientId && c.clientSecret),
    connected: !!(c.accessToken && c.campaignId),
    clientId: c.clientId || null,
    campaignId: c.campaignId || null,
    defaultMinCents: c.defaultMinCents || 0,
    tokenExp: c.tokenExp || 0,
    hasSecret: !!c.clientSecret,
  };
}

// Upsert. Only overwrites secret/token fields when a new value is provided, so
// the admin form can be re-saved without re-pasting the secret.
export function saveOwnerConfig(siteId, patch) {
  if (!cryptoBoxReady()) throw new Error('PAID_SECRET is not set: cannot store Patreon secrets');
  const cur = getOwnerConfig(siteId) || {};
  const merged = {
    clientId: patch.clientId ?? cur.clientId ?? null,
    clientSecret: patch.clientSecret ?? cur.clientSecret ?? null,
    campaignId: patch.campaignId ?? cur.campaignId ?? null,
    accessToken: patch.accessToken ?? cur.accessToken ?? null,
    refreshToken: patch.refreshToken ?? cur.refreshToken ?? null,
    tokenExp: patch.tokenExp ?? cur.tokenExp ?? 0,
    defaultMinCents: patch.defaultMinCents ?? cur.defaultMinCents ?? 0,
  };
  db.prepare(`INSERT INTO paid_patreon
      (site_id, client_id, client_secret_enc, campaign_id, access_token_enc, refresh_token_enc, token_exp, default_min_cents, updated_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(site_id) DO UPDATE SET
      client_id=excluded.client_id, client_secret_enc=excluded.client_secret_enc,
      campaign_id=excluded.campaign_id, access_token_enc=excluded.access_token_enc,
      refresh_token_enc=excluded.refresh_token_enc, token_exp=excluded.token_exp,
      default_min_cents=excluded.default_min_cents, updated_at=CURRENT_TIMESTAMP`)
    .run(
      siteId,
      merged.clientId,
      merged.clientSecret != null ? encrypt(merged.clientSecret) : null,
      merged.campaignId,
      merged.accessToken != null ? encrypt(merged.accessToken) : null,
      merged.refreshToken != null ? encrypt(merged.refreshToken) : null,
      merged.tokenExp || 0,
      Math.max(0, parseInt(merged.defaultMinCents, 10) || 0),
    );
}

export function disconnect(siteId) {
  db.prepare('DELETE FROM paid_patreon WHERE site_id = ?').run(siteId);
}

export function defaultMinCents(siteId) {
  const row = db.prepare('SELECT default_min_cents FROM paid_patreon WHERE site_id = ?').get(siteId);
  return row ? (row.default_min_cents || 0) : 0;
}

// True when the stored creator token is missing or within `skewSeconds` of exp.
export function needsRefresh(siteId, skewSeconds = 3600) {
  const c = getOwnerConfig(siteId);
  if (!c || !c.refreshToken) return false;
  return !c.accessToken || (c.tokenExp || 0) <= (Math.floor(Date.now() / 1000) + skewSeconds);
}

// Refresh the creator token via Patreon. Returns true on success. `fetchImpl`
// is injectable for tests; defaults to global fetch.
export async function refreshCreatorToken(siteId, fetchImpl = fetch) {
  const c = getOwnerConfig(siteId);
  if (!c || !c.clientId || !c.clientSecret || !c.refreshToken) return false;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: c.refreshToken,
    client_id: c.clientId,
    client_secret: c.clientSecret,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return false;
  const j = await res.json();
  if (!j || !j.access_token) return false;
  saveOwnerConfig(siteId, {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || c.refreshToken,
    tokenExp: Math.floor(Date.now() / 1000) + (parseInt(j.expires_in, 10) || 0),
  });
  return true;
}

// A valid creator access token, refreshing first if it is stale. Null when the
// owner has not connected. Used by the patron verify path (slice 3).
export async function creatorAccessToken(siteId, fetchImpl = fetch) {
  if (needsRefresh(siteId)) { try { await refreshCreatorToken(siteId, fetchImpl); } catch { /* fall through */ } }
  const c = getOwnerConfig(siteId);
  return c && c.accessToken ? c.accessToken : null;
}

// Pure: pick the membership for the owner's campaign out of a Patreon
// identity?include=memberships.campaign response (JSON:API). Returns
// { status, cents } or null.
export function pickCampaignMembership(identity, campaignId) {
  const inc = (identity && identity.included) || [];
  for (const it of inc) {
    if (it.type !== 'member') continue;
    const camp = it.relationships && it.relationships.campaign && it.relationships.campaign.data;
    if (!camp || String(camp.id) !== String(campaignId)) continue;
    const a = it.attributes || {};
    return { status: a.patron_status || null, cents: a.currently_entitled_amount_cents || 0 };
  }
  return null;
}

// Exchange a patron's auth code and read their membership of the owner's
// campaign. Returns { status, cents } or null. The patron token is used once
// and discarded here: nothing identifying is stored (design decision).
export async function verifyPatron(siteId, code, redirectUri, fetchImpl = fetch) {
  const c = getOwnerConfig(siteId);
  if (!c || !c.clientId || !c.clientSecret || !c.campaignId) return null;
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri,
    }).toString(),
  });
  if (!tokenRes.ok) return null;
  const tok = await tokenRes.json();
  if (!tok || !tok.access_token) return null;
  const url = 'https://www.patreon.com/api/oauth2/v2/identity'
    + '?include=memberships.campaign'
    + '&fields%5Bmember%5D=patron_status,currently_entitled_amount_cents';
  const idRes = await fetchImpl(url, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!idRes.ok) return null;
  const identity = await idRes.json();
  return pickCampaignMembership(identity, c.campaignId);   // token goes out of scope, discarded
}

function safeDecrypt(blob) {
  try { return decrypt(blob); } catch { return null; }
}

export default {
  getOwnerConfig, ownerStatus, saveOwnerConfig, disconnect,
  defaultMinCents, needsRefresh, refreshCreatorToken, creatorAccessToken,
  pickCampaignMembership, verifyPatron,
};
