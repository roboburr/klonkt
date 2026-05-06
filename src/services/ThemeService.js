/**
 * ThemeService — Palette and theme management
 * 
 * 8 Built-in Palettes (from v9):
 * - Sage (default, warm crème)
 * - Paper (minimalist white)
 * - Ocean (cool blues)
 * - Forest (greens)
 * - Stone (grays)
 * - Midnight (dark blue)
 * - Sunset (warm oranges)
 * - Cream (light beige)
 * 
 * Dark/Light mode toggle stored per user
 */

class ThemeService {
  static PALETTES = {
    sage: {
      name: 'Sage',
      light: { paper: '#faf8f3', ink: '#1a1a1a', accent: '#c2410c' },
      dark: { paper: '#1c1a17', ink: '#f4ede0', accent: '#c2410c' }
    },
    paper: {
      name: 'Paper',
      light: { paper: '#ffffff', ink: '#09090b', accent: '#000000' },
      dark: { paper: '#09090b', ink: '#fafafa', accent: '#ffffff' }
    },
    ocean: {
      name: 'Ocean',
      light: { paper: '#f0f9ff', ink: '#0c2d48', accent: '#0369a1' },
      dark: { paper: '#001f3f', ink: '#e0f2fe', accent: '#06b6d4' }
    },
    forest: {
      name: 'Forest',
      light: { paper: '#f0fdf4', ink: '#15803d', accent: '#16a34a' },
      dark: { paper: '#052e16', ink: '#dcfce7', accent: '#22c55e' }
    },
    stone: {
      name: 'Stone',
      light: { paper: '#f5f5f5', ink: '#262626', accent: '#737373' },
      dark: { paper: '#1f1f1f', ink: '#e5e5e5', accent: '#a3a3a3' }
    },
    midnight: {
      name: 'Midnight',
      light: { paper: '#f8fafc', ink: '#1e293b', accent: '#3b82f6' },
      dark: { paper: '#0f172a', ink: '#f1f5f9', accent: '#60a5fa' }
    },
    sunset: {
      name: 'Sunset',
      light: { paper: '#fef3c7', ink: '#92400e', accent: '#f97316' },
      dark: { paper: '#5a1f08', ink: '#fef3c7', accent: '#fb923c' }
    },
    cream: {
      name: 'Cream',
      light: { paper: '#fffbf0', ink: '#78350f', accent: '#d97706' },
      dark: { paper: '#3f2305', ink: '#fffbf0', accent: '#f59e0b' }
    }
  };

  /**
   * Curated accent palette — admins pick one of these instead of a free-form
   * hex picker. Keeps the brand consistent and avoids unreadable combinations.
   * Each color works against both light and dark themes.
   */
  static ACCENTS = [
    { key: 'orange',  name: 'Oranje',  color: '#c2410c' },
    { key: 'sage',    name: 'Salie',   color: '#5a8a5a' },
    { key: 'ocean',   name: 'Oceaan',  color: '#0369a1' },
    { key: 'forest',  name: 'Bos',     color: '#16a34a' },
    { key: 'plum',    name: 'Pruim',   color: '#9d3a78' },
    { key: 'gold',    name: 'Goud',    color: '#d97706' },
    { key: 'crimson', name: 'Karmijn', color: '#ef2840' },
    { key: 'indigo',  name: 'Indigo',  color: '#6366f1' },
  ];

  static listAccents() {
    return this.ACCENTS;
  }

  /**
   * Validate an accent color. Returns the canonical hex if it's in the curated
   * set (case-insensitive match), or null if it's not. Server-side validation
   * uses this so we never persist arbitrary hex from the form.
   */
  static validateAccent(hex) {
    if (!hex || typeof hex !== 'string') return null;
    const target = hex.trim().toLowerCase();
    const found = this.ACCENTS.find(a => a.color.toLowerCase() === target);
    return found ? found.color : null;
  }

  /**
   * Get palette data
   */
  static getPalette(paletteKey) {
    return this.PALETTES[paletteKey] || this.PALETTES.sage;
  }

  /**
   * Get all available palettes (with full color data so a picker UI can
   * render true previews of paper/ink/accent for both light and dark).
   */
  static listPalettes() {
    return Object.entries(this.PALETTES).map(([key, data]) => ({
      key,
      name: data.name,
      light: data.light,
      dark: data.dark,
    }));
  }

  /**
   * Generate CSS variables for palette + theme
   */
  static generateCSSVars(paletteKey, theme = 'dark', accentColor = null) {
    const palette = this.getPalette(paletteKey);
    const colors = theme === 'dark' ? palette.dark : palette.light;
    const accent = accentColor || colors.accent;

    return `
      :root {
        --palette: ${paletteKey};
        --theme: ${theme};
        --paper: ${colors.paper};
        --ink: ${colors.ink};
        --accent: ${accent};
      }
    `.trim();
  }

  /**
   * Update user's theme preference
   */
  static updateUserTheme(db, userId, theme, palette) {
    if (!['dark', 'light'].includes(theme)) {
      throw new Error('Invalid theme. Must be "dark" or "light"');
    }
    if (!this.PALETTES[palette]) {
      throw new Error('Invalid palette');
    }

    db.prepare(`
      UPDATE users SET theme = ?, palette = ? WHERE id = ?
    `).run(theme, palette, userId);
  }

  /**
   * Update site's palette + accent
   */
  static updateSitePalette(db, siteId, paletteKey, accentColor) {
    if (!this.PALETTES[paletteKey]) {
      throw new Error('Invalid palette');
    }
    if (!/^#[0-9a-f]{6}$/i.test(accentColor)) {
      throw new Error('Invalid accent color. Must be hex #RRGGBB');
    }

    db.prepare(`
      UPDATE sites SET palette = ?, accent = ? WHERE id = ?
    `).run(paletteKey, accentColor, siteId);
  }

  /**
   * Generate full HTML theme meta tags
   */
  static generateThemeMeta(userTheme, userPalette, siteTheme, siteAccent) {
    const theme = userTheme || siteTheme || 'dark';
    const palette = userPalette || 'sage';
    const accent = siteAccent || '#c2410c';
    const paletteData = this.getPalette(palette);
    const colors = theme === 'dark' ? paletteData.dark : paletteData.light;

    return {
      colorScheme: 'dark light',
      themeColor: accent,
      appleMobileWebAppStatusBarStyle: 'black-translucent',
      cssVars: this.generateCSSVars(palette, theme, accent),
      inline: `
        <style>
          html {
            color-scheme: ${theme === 'dark' ? 'dark light' : 'light dark'};
          }
          :root {
            --paper: ${colors.paper};
            --ink: ${colors.ink};
            --accent: ${accent};
          }
        </style>
        <script>
          // Apply theme ASAP (before paint) to avoid flash
          (function() {
            try {
              const t = localStorage.getItem('pcms-theme') || '${theme}';
              const p = localStorage.getItem('pcms-palette') || '${palette}';
              document.documentElement.setAttribute('data-theme', t);
              document.documentElement.setAttribute('data-palette', p);
            } catch(e) {}
          })();
        </script>
      `.trim()
    };
  }
}

export default ThemeService;
