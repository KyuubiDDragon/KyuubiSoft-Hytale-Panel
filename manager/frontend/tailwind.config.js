/** @type {import('tailwindcss').Config} */
export default {
  // Class strategy so the existing `dark:` utilities keep working but we can
  // also opt into Light Mode by toggling a single class on <html>.
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Semantic surface colors that read CSS custom properties so the
        // active theme can be flipped at runtime without rebuilding Tailwind.
        surface: {
          base: 'rgb(var(--surface-base) / <alpha-value>)',
          panel: 'rgb(var(--surface-panel) / <alpha-value>)',
          elevated: 'rgb(var(--surface-elevated) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
        },
        ink: {
          primary: 'rgb(var(--ink-primary) / <alpha-value>)',
          secondary: 'rgb(var(--ink-secondary) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
        },
        // Hytale Brand Colors
        hytale: {
          orange: '#FF6B35',
          'orange-dark': '#E55A2B',
          'orange-light': '#FF8555',
          yellow: '#FFB845',
          gold: '#FFAA00',
        },
        // Dark Theme Backgrounds
        dark: {
          DEFAULT: '#1A1D23',
          50: '#2D323C',
          100: '#282D36',
          200: '#242830',
          300: '#1F232A',
          400: '#1A1D23',
          500: '#15171C',
          600: '#101215',
          700: '#0B0C0E',
          800: '#060707',
          900: '#000000',
        },
        // Inventory UI Colors (neutral dark, matching panel theme)
        inv: {
          bg: '#15171C',
          panel: '#242830',
          'panel-light': '#282D36',
          slot: '#1A1D23',
          'slot-fill': '#1F232A',
          border: '#2D323C',
          'border-light': '#3D4350',
          accent: '#FF6B35',
          header: '#282D36',
        },
        // Status Colors
        status: {
          success: '#4ADE80',
          warning: '#FBBF24',
          error: '#EF4444',
          info: '#60A5FA',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        'glow-orange': '0 0 20px rgba(255, 107, 53, 0.3)',
        'glow-success': '0 0 20px rgba(74, 222, 128, 0.3)',
        'glow-error': '0 0 20px rgba(239, 68, 68, 0.3)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'extraction-progress': {
          '0%': { width: '0%', marginLeft: '0%' },
          '50%': { width: '40%', marginLeft: '30%' },
          '100%': { width: '0%', marginLeft: '100%' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.5s ease-in-out infinite',
        'extraction-progress': 'extraction-progress 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
