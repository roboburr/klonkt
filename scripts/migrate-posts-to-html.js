/**
 * P58 — One-shot migration: convert markdown post.content to sanitized HTML.
 *
 * Run on the server AFTER deploying P58:
 *   node scripts/migrate-posts-to-html.js
 *
 * Idempotent: posts whose content already starts with '<' are detected as
 * HTML and skipped. Markdown posts are rendered via MarkdownService, then
 * sanitized via HtmlSanitizerService, then written back. Original markdown
 * is preserved in posts.content_legacy_md so we can roll back if needed.
 *
 * Re-running the script after the column is added is safe — the second run
 * will see HTML content and skip everything.
 */

import db from '../src/config/database.js';
import MarkdownService from '../src/services/MarkdownService.js';
import HtmlSanitizerService from '../src/services/HtmlSanitizerService.js';

function ensureBackupColumn() {
  // Try to add the legacy_md backup column; SQLite throws if it exists.
  try {
    db.exec(`ALTER TABLE posts ADD COLUMN content_legacy_md TEXT`);
    console.log('  + added posts.content_legacy_md column');
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}

function looksLikeHtml(s) {
  if (!s) return false;
  // Heuristic: starts with a tag, OR contains common block-level tags. Doesn't
  // need to be airtight — false positives just mean we skip a post that's
  // already mostly HTML, which is fine.
  const t = s.trimStart();
  return t.startsWith('<') || /<\/?(p|h[1-6]|ul|ol|li|blockquote|figure|img|div)\b/i.test(s);
}

function migrateOne(post) {
  if (!post.content || !post.content.trim()) {
    return { id: post.id, action: 'empty' };
  }
  if (looksLikeHtml(post.content)) {
    return { id: post.id, action: 'skipped-already-html' };
  }
  if (post.content_legacy_md) {
    // Already migrated (legacy backup exists) but content somehow markdown again?
    return { id: post.id, action: 'skipped-already-backed-up' };
  }

  const renderedHtml = MarkdownService.render(post.content);
  const cleanHtml    = HtmlSanitizerService.sanitize(renderedHtml);

  db.prepare(`
    UPDATE posts SET content = ?, content_legacy_md = ?, updated_at = updated_at
    WHERE id = ?
  `).run(cleanHtml, post.content, post.id);

  return { id: post.id, action: 'migrated', from: post.content.length, to: cleanHtml.length };
}

function main() {
  console.log('PrutFolio P58 — markdown → HTML post migration\n');
  ensureBackupColumn();

  const posts = db.prepare(`SELECT id, slug, content, content_legacy_md FROM posts`).all();
  console.log(`  found ${posts.length} posts\n`);

  const stats = { migrated: 0, skipped: 0, empty: 0 };
  for (const p of posts) {
    const r = migrateOne(p);
    const tag = r.action.startsWith('skipped') ? 'skipped' :
                r.action === 'empty' ? 'empty' : 'migrated';
    stats[tag]++;
    const detail = r.action === 'migrated' ? ` (${r.from} md → ${r.to} html chars)` : ` [${r.action}]`;
    console.log(`  - ${p.slug}${detail}`);
  }

  console.log(`\nDone. migrated=${stats.migrated}  skipped=${stats.skipped}  empty=${stats.empty}`);
  console.log('Backup column posts.content_legacy_md retains original markdown.');
}

main();
