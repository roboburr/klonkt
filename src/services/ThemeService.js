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
  // Paper/ink values map 1-to-1 from the [data-palette] CSS in style.css (= what
  // is ACTUALLY applied); the accent dot is a representative color per palette.
  static PALETTES = {
    // Brand default — matches klonkt.com (dark blue + gold).
    klonkt: {
      name: 'Klonkt',
      light: { paper: '#f3f1ea', ink: '#11141c', accent: '#c98a2a' },
      dark: { paper: '#0b0d12', ink: '#f3f1ea', accent: '#e8b04b' }
    },
    sage: {
      name: 'Sage',
      light: { paper: '#faf8f3', ink: '#1a1a1a', accent: '#c2410c' },
      dark: { paper: '#1c1a17', ink: '#f4ede0', accent: '#c2410c' }
    },
    paper: {
      name: 'Paper',
      light: { paper: '#ffffff', ink: '#09090b', accent: '#000000' },
      dark: { paper: '#0a0a0a', ink: '#fafafa', accent: '#ffffff' }
    },
    forest: {
      name: 'Forest',
      light: { paper: '#f2f6ed', ink: '#1a2e15', accent: '#4d7c2a' },
      dark: { paper: '#0d1f12', ink: '#dcf2d0', accent: '#6fae3f' }
    },
    stone: {
      name: 'Stone',
      light: { paper: '#f5f0e8', ink: '#2b2218', accent: '#8a6a45' },
      dark: { paper: '#1a130b', ink: '#f5e9d5', accent: '#b89366' }
    },
    midnight: {
      name: 'Midnight',
      light: { paper: '#f3f1f8', ink: '#1e1a2e', accent: '#7c5cbf' },
      dark: { paper: '#0f0a1f', ink: '#e9def7', accent: '#9d88e0' }
    },
    sunset: {
      name: 'Sunset',
      light: { paper: '#fdf4f3', ink: '#2e1618', accent: '#d6477f' },
      dark: { paper: '#1f0a14', ink: '#fce7f3', accent: '#f06fa3' }
    },
    cream: {
      name: 'Cream',
      light: { paper: '#fefaf0', ink: '#2a1f0f', accent: '#d97706' },
      dark: { paper: '#1a1208', ink: '#fef3d6', accent: '#f0a93a' }
    },
    rose: {
      name: 'Rose',
      light: { paper: '#fdf2f4', ink: '#2e1419', accent: '#e11d6b' },
      dark: { paper: '#1f0a0f', ink: '#fce4ea', accent: '#f06b9a' }
    },
    // key stays 'mint' (DB-safe), but recolored to warm Terracotta — less green.
    mint: {
      name: 'Terracotta',
      light: { paper: '#faf2ee', ink: '#2e1a12', accent: '#c2410c' },
      dark: { paper: '#1f120c', ink: '#f7e6da', accent: '#e8783f' }
    },
    lilac: {
      name: 'Lilac',
      light: { paper: '#faf4fb', ink: '#2a1830', accent: '#a855f7' },
      dark: { paper: '#170a1c', ink: '#f3e2f7', accent: '#c084fc' }
    }
  };

  /**
   * Curated accent palette — admins pick one of these instead of a free-form
   * hex picker. Keeps the brand consistent and avoids unreadable combinations.
   * Each color works against both light and dark themes.
   */
  // Balanced across the color wheel — fewer greens/blues (4 of 12),
  // more warm + purple/pink variation. All readable on both light and dark.
  static ACCENTS = [
    { key: 'klonkt',  name: 'Klonkt-geel', color: '#e8b04b' },
    { key: 'red',     name: 'Rood',      color: '#dc2626' },
    { key: 'orange',  name: 'Oranje',    color: '#ea580c' },
    { key: 'amber',   name: 'Amber',     color: '#d97706' },
    { key: 'forest',  name: 'Groen',     color: '#16a34a' },
    { key: 'teal',    name: 'Turquoise', color: '#0d9488' },
    { key: 'ocean',   name: 'Blauw',     color: '#2563eb' },
    { key: 'indigo',  name: 'Indigo',    color: '#4f46e5' },
    { key: 'violet',  name: 'Violet',    color: '#7c3aed' },
    { key: 'plum',    name: 'Magenta',   color: '#c026d3' },
    { key: 'pink',    name: 'Roze',      color: '#db2777' },
    { key: 'brown',   name: 'Bruin',     color: '#9a3412' },
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
    return this.PALETTES[paletteKey] || this.PALETTES.klonkt;
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
    const palette = userPalette || 'klonkt';
    const accent = siteAccent || '#e8b04b';
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
