import { marked } from 'marked';

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true, // GitHub Flavored Markdown
  pedantic: false
});

export class MarkdownService {
  /**
   * Convert markdown to HTML
   */
  static render(markdown) {
    try {
      if (!markdown) return '';

      // Sanitize: remove script tags and dangerous HTML
      const sanitized = this.sanitize(markdown);

      // Render markdown
      const html = marked(sanitized);

      return html;
    } catch (err) {
      console.error('❌ Markdown render error:', err);
      return `<p>Error rendering content</p>`;
    }
  }

  /**
   * Sanitize markdown to prevent XSS
   */
  static sanitize(markdown) {
    if (!markdown) return '';

    // Remove script tags
    let sanitized = markdown.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

    // Remove on* event handlers
    sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
    sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]*/gi, '');

    // Remove javascript: protocol
    sanitized = sanitized.replace(/javascript:/gi, '');

    return sanitized;
  }

  /**
   * Extract plain text from markdown
   */
  static toPlainText(markdown) {
    if (!markdown) return '';

    return markdown
      .replace(/[#*_`\[\]()]/g, '') // Remove markdown syntax
      .replace(/\n+/g, ' ') // Collapse newlines
      .trim();
  }

  /**
   * Generate preview (first 200 chars)
   */
  static preview(markdown, length = 200) {
    const plainText = this.toPlainText(markdown);
    return plainText.substring(0, length) + (plainText.length > length ? '...' : '');
  }
}

export default MarkdownService;
