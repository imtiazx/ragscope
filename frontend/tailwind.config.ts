import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  // Data-attribute based dark mode to match our ThemeProvider
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Each color references a CSS variable so the palette swaps when
        // the data-theme attribute changes on <html> -- no JS required for
        // the color switch, it is pure CSS variable cascading.
        background: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        border: 'var(--color-border)',
        accent: 'var(--color-accent)',
        'accent-dim': 'var(--color-accent-dim)',
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      keyframes: {
        // Subtle pulse for the accent glow on CTAs
        'glow-pulse': {
          '0%, 100%': {
            boxShadow: '0 0 8px 0px rgba(0, 212, 255, 0.4)',
          },
          '50%': {
            boxShadow: '0 0 24px 4px rgba(0, 212, 255, 0.7)',
          },
        },
        // Fade in from slightly below -- used for cards and modals
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        // Horizontal scan line for loading states
        'scan': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(400%)' },
        },
        // Count-up shimmer for score cards
        'count-shimmer': {
          '0%': { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition: '200% center' },
        },
      },
      animation: {
        'glow-pulse': 'glow-pulse 2.5s ease-in-out infinite',
        'fade-up': 'fade-up 0.4s ease-out forwards',
        'scan': 'scan 1.6s linear infinite',
        'count-shimmer': 'count-shimmer 1.2s linear',
      },
    },
  },
  plugins: [],
}

export default config
