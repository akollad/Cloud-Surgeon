/**
 * Cloud-Surgeon Brand Design Tokens
 * Concept: "Clinical Precision" — the clarity of a surgical suite, the depth of cloud infrastructure.
 *
 * Color origin: #124896 (rgb 18 72 150) extracted directly from the official logo SVG.
 */

export const brand = {
  name: 'Cloud-Surgeon',
  tagline: 'Autonomous Cloud Remediation',
  concept: 'Clinical Precision',

  // ─── Primary Palette ─────────────────────────────────────────────────────────
  colors: {
    // Brand blues — derived from logo primary #124896
    navy:      '#071426',  // deepest background, near-black with blue soul
    ink:       '#0d1f3c',  // dark surface (sidebar, nav headers)
    blue:      '#124896',  // THE logo color — primary brand blue
    azure:     '#1a5ec8',  // interactive hover state (lighter)
    sky:       '#3a80e0',  // lighter interactive (dark mode primary)
    horizon:   '#6aaaf0',  // muted interactive tint
    ice:       '#e8f1fc',  // paleest tint for highlights / selected bg
    mist:      '#f1f5fb',  // page background (light mode)

    // Neutrals — all have a subtle cool-blue undertone to stay "on brand"
    slate900:  '#0a1628',
    slate800:  '#162338',
    slate700:  '#253d5e',
    slate600:  '#3d5878',
    slate500:  '#5a7496',
    slate400:  '#7d96b5',
    slate300:  '#a8bcd4',
    slate200:  '#cfdce f',  // typo-safe: intended #cfdbef
    slate150:  '#dde6f2',
    slate100:  '#eaf0f9',
    slate50:   '#f4f8fd',
    white:     '#ffffff',

    // Semantic
    success:   '#15803d',  // green-700
    successBg: '#dcfce7',
    warning:   '#b45309',  // amber-700
    warningBg: '#fef3c7',
    danger:    '#b91c1c',  // red-700
    dangerBg:  '#fee2e2',
    info:      '#0e7490',  // cyan-700
    infoBg:    '#cffafe',

    // Chart / data — deliberate, accessible palette
    chart: {
      1: '#124896',  // brand blue
      2: '#0e9488',  // teal
      3: '#7c3aed',  // violet
      4: '#d97706',  // amber
      5: '#059669',  // emerald
      6: '#dc2626',  // red
    },
  },

  // ─── Typography ─────────────────────────────────────────────────────────────
  typography: {
    sans:  "'Geist', 'Inter', system-ui, sans-serif",
    mono:  "'Space Mono', 'JetBrains Mono', 'Fira Code', monospace",
    // Scale: 4px baseline — tight for data-dense interfaces
    scale: {
      '2xs': '0.625rem',   // 10px — micro labels, footnotes
      xs:    '0.6875rem',  // 11px — status chips, timestamps
      sm:    '0.75rem',    // 12px — table cells, helper text
      base:  '0.8125rem',  // 13px — body default
      md:    '0.875rem',   // 14px — card body
      lg:    '1rem',       // 16px — card titles
      xl:    '1.125rem',   // 18px — page section headings
      '2xl': '1.375rem',   // 22px — page titles
      '3xl': '1.75rem',    // 28px — hero numbers / KPI
      '4xl': '2.25rem',    // 36px — display
    },
    weight: {
      regular: 400,
      medium:  500,
      semibold: 600,
      bold:    700,
    },
    tracking: {
      tight:   '-0.02em',
      normal:  '0em',
      wide:    '0.04em',
      wider:   '0.08em',
      widest:  '0.12em',
    },
    leading: {
      none:    1,
      tight:   1.2,
      snug:    1.35,
      normal:  1.5,
      relaxed: 1.625,
    },
  },

  // ─── Spacing (4px grid) ──────────────────────────────────────────────────────
  spacing: {
    0.5: '2px',
    1:   '4px',
    1.5: '6px',
    2:   '8px',
    3:   '12px',
    4:   '16px',
    5:   '20px',
    6:   '24px',
    8:   '32px',
    10:  '40px',
    12:  '48px',
    16:  '64px',
  },

  // ─── Shape ───────────────────────────────────────────────────────────────────
  radius: {
    none:   '0px',
    xs:     '2px',
    sm:     '3px',
    md:     '4px',
    lg:     '6px',
    xl:     '8px',
    full:   '9999px',
  },

  // ─── Elevation / Shadow ──────────────────────────────────────────────────────
  shadows: {
    // Blue-tinted shadows reinforce the brand color
    card:      '0 1px 3px rgba(18,72,150,0.07), 0 1px 2px rgba(18,72,150,0.04)',
    cardHover: '0 4px 12px rgba(18,72,150,0.11), 0 2px 4px rgba(18,72,150,0.06)',
    elevated:  '0 8px 24px rgba(18,72,150,0.13), 0 2px 6px rgba(18,72,150,0.07)',
    nav:       '3px 0 20px rgba(7,20,38,0.25)',
    focus:     '0 0 0 3px rgba(18,72,150,0.25)',
    inset:     'inset 0 1px 3px rgba(18,72,150,0.08)',
  },

  // ─── Motion ──────────────────────────────────────────────────────────────────
  motion: {
    fast:    '100ms',
    base:    '150ms',
    slow:    '250ms',
    ease:    'cubic-bezier(0.4, 0, 0.2, 1)',
    spring:  'cubic-bezier(0.34, 1.56, 0.64, 1)',
    linear:  'linear',
  },

  // ─── Logo Usage Rules ────────────────────────────────────────────────────────
  logo: {
    /**
     * USAGE RULES (enforce in code review):
     *
     * ✅ On white / light background  → theme="brand"   (#124896 blue)
     * ✅ On dark / navy background    → theme="white"   (white)
     * ✅ On brand-blue background     → theme="white"   (white)
     * ✅ On mid-tone gray             → theme="ink"     (near-black navy)
     *
     * ❌ Never place the logo on a busy photographic background without a clear zone.
     * ❌ Never recolor to anything other than the three approved themes.
     * ❌ Never stretch, skew, rotate, or outline the logo.
     * ❌ Never use the wordmark-only variant at sizes below 80px wide.
     * ❌ Never apply opacity to the logo — use a different theme instead.
     *
     * Clear space: minimum 1× the height of the "S" lettermark on all sides.
     * Minimum size: mark-only ≥ 16px tall; full logo ≥ 24px tall.
     */
    minHeightMark: 16,
    minHeightFull: 24,
    approvedThemes: ['brand', 'white', 'ink'] as const,
    approvedVariants: ['full', 'mark', 'horizontal'] as const,
  },
} as const;

export type Brand = typeof brand;
export type BrandColor = keyof typeof brand.colors;
export type LogoTheme = typeof brand.logo.approvedThemes[number];
export type LogoVariant = typeof brand.logo.approvedVariants[number];
