/**
 * Render helper — THE pattern for the entire app.
 * 
 * Two modes:
 *   1. HTMX request → render just the page content (no shell)
 *   2. Full page request → render content, then embed in shell
 * 
 * Usage:
 *   renderPage(req, res, 'pages/home', { posts, ...data })
 */

import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import db from '../config/database.js';
import PermissionsService from '../services/PermissionsService.js';
import { PLATFORMS as PLATFORMS_CATALOG } from '../services/PlatformIcons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEWS_DIR = path.join(__dirname, '..', 'views');

const formatDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const months = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
};

const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' });
};

export async function renderPage(req, res, viewName, data = {}) {
  // Decide: partial (HTMX) or full?
  const isPartial = req.headers['hx-request'] === 'true' || req.query.partial === '1';

  // Bezit deze (niet-god) user een eigen site? Bepaalt of 'ie een "Beheer"-
  // ingang ziet (artiest-zelfbeheer). god ziet beheer sowieso (op rol).
  const _u = req.session?.user || null;
  const userOwnsSite = !!(_u && _u.role !== 'god' &&
    db.prepare('SELECT 1 FROM sites WHERE owner_id = ? LIMIT 1').get(_u.id));

  // De avatar van de SITE-EIGENAAR (niet de kijker!) — voor de PrutFolio-kop,
  // zodat de artiest z'n eigen account-foto als sitefoto kan gebruiken.
  const _site = data.site || res.locals.site || null;
  const siteOwnerAvatar = (_site && _site.owner_id)
    ? (db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(_site.owner_id)?.avatar_url || null)
    : null;

  // Common locals
  const locals = {
    user: _u,
    userOwnsSite,
    siteOwnerAvatar,
    site: _site,
    audioTracks: data.audioTracks || res.locals.audioTracks || [],
    siteUrlBase: res.locals.siteUrlBase || '',
    tenancy: res.locals.tenancy || 'solo',
    platforms_catalog: PLATFORMS_CATALOG,
    permissions: PermissionsService,
    formatDate,
    formatDateTime,
    pageTitle: data.pageTitle || (data.site && data.site.title) || 'PrutCMS',
    bodyClass: data.bodyClass || 'on-home',
    socialDescr: data.socialDescr || '',
    socialImage: data.socialImage || '',
    cspNonce: () => '',
    currentPath: req.path,
    ...data,
  };

  try {
    // Step 1: Render the page view to HTML
    const viewPath = path.join(VIEWS_DIR, viewName + '.ejs');
    const pageContent = await ejs.renderFile(viewPath, locals, { async: false });

    if (isPartial) {
      // HTMX: just send the content. Set HX-Trigger for body class swap
      res.setHeader('HX-Trigger-After-Settle', JSON.stringify({
        pcmsNav: { bodyClass: locals.bodyClass },
        pcmsPostSwap: data.post ? {
          title: data.post.title,
          slug: data.post.slug,
          pageTitle: locals.pageTitle,
        } : null,
      }));
      return res.send(pageContent);
    }

    // Full: wrap content in shell
    locals.pageContent = pageContent;
    res.render('shell', locals);
  } catch (err) {
    console.error('[renderPage] Error rendering', viewName, err);
    if (process.env.NODE_ENV === 'production') {
      return res.status(500).send('Internal Server Error');
    }
    // Dev: surface the underlying cause prominently. EJS rewrites err.message
    // to include the file/line/code-context, so we also surface name+stack
    // separately in case the message was truncated or empty.
    const escape = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    res.status(500).send(`<!doctype html>
<meta charset="utf-8">
<title>Render error: ${escape(viewName)}</title>
<style>
  body { font: 14px/1.5 ui-monospace, monospace; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; background:#1a1a1a; color:#eee; }
  h1 { color:#dc2626; font-family: ui-sans-serif, system-ui; }
  h2 { color:#fb923c; font-size:1rem; margin-top:1.5rem; }
  pre { background:#0a0a0a; border:1px solid #333; border-radius:6px; padding:1rem; overflow:auto; white-space:pre-wrap; word-break:break-word; }
  .cause { background:#3d0a0a; border-color:#7a1a1a; color:#fca5a5; font-weight:600; }
</style>
<h1>Render error in ${escape(viewName)}</h1>
<h2>Cause</h2>
<pre class="cause">${escape(err.name || 'Error')}: ${escape(err.message || '(no message)')}</pre>
<h2>Stack</h2>
<pre>${escape(err.stack || '(no stack)')}</pre>
${err.path ? `<h2>File</h2><pre>${escape(err.path)}</pre>` : ''}
`);
  }
}
