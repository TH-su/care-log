/**
 * 色・文字サイズ・角丸は tokens.css のトークンで theme を「置換」する
 * （text-slate-500 や text-[14px] のような直書きクラスをそもそも存在させないため）。
 * 余白は Tailwind 既定が 4px グリッド＝デザインシステムと同格のため既定を残し、
 * タップ領域だけ tap / gap を追加する。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      bg: 'var(--c-bg)',
      surface: 'var(--c-surface)',
      surface2: 'var(--c-surface2)',
      ink: 'var(--c-ink)',
      ink2: 'var(--c-ink2)',
      ink3: 'var(--c-ink3)',
      border: 'var(--c-border)',
      'border-strong': 'var(--c-border-strong)',
      primary: 'var(--c-primary)',
      'primary-hover': 'var(--c-primary-hover)',
      'primary-ink': 'var(--c-primary-ink)',
      link: 'var(--c-link)',
      accent: 'var(--c-accent)',
      'accent-bg': 'var(--c-accent-bg)',
      'accent-ink': 'var(--c-accent-ink)',
      'accent-on-dark': 'var(--c-accent-on-dark)',
      'accent-on-dark-ink': 'var(--c-accent-on-dark-ink)',
      hero: 'var(--c-hero)',
      'hero-ink': 'var(--c-hero-ink)',
      ok: 'var(--c-ok)',
      'ok-bg': 'var(--c-ok-bg)',
      warn: 'var(--c-warn)',
      'warn-bg': 'var(--c-warn-bg)',
      danger: 'var(--c-danger)',
      'danger-bg': 'var(--c-danger-bg)',
      info: 'var(--c-info)',
      'info-bg': 'var(--c-info-bg)',
      focus: 'var(--c-focus)',
    },
    fontSize: {
      '2xs': ['var(--fs-2xs)', { lineHeight: 'var(--lh-tight)' }],
      xs: ['var(--fs-xs)', { lineHeight: 'var(--lh-tight)' }],
      sm: ['var(--fs-sm)', { lineHeight: 'var(--lh-base)' }],
      base: ['var(--fs-base)', { lineHeight: 'var(--lh-base)' }],
      lg: ['var(--fs-lg)', { lineHeight: 'var(--lh-base)' }],
      xl: ['var(--fs-xl)', { lineHeight: 'var(--lh-tight)' }],
      '2xl': ['var(--fs-2xl)', { lineHeight: 'var(--lh-tight)' }],
    },
    borderRadius: {
      none: '0',
      sm: 'var(--r-sm)',
      DEFAULT: 'var(--r-md)',
      md: 'var(--r-md)',
      lg: 'var(--r-lg)',
      full: '9999px',
    },
    fontFamily: {
      sans: 'var(--font-sans)',
      num: 'var(--font-num)',
    },
    extend: {
      spacing: {
        tap: 'var(--tap-min)',
        gap: 'var(--tap-gap)',
      },
      fontWeight: {
        normal: 'var(--fw-normal)',
        bold: 'var(--fw-bold)',
        heavy: 'var(--fw-heavy)',
      },
      minHeight: { tap: 'var(--tap-min)' },
      minWidth: { tap: 'var(--tap-min)' },
    },
  },
  plugins: [],
}
