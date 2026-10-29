import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),
    // Service worker + manifest. autoUpdate so a fresh build wins next page
    // load; we don't show an install prompt — operators interact with the
    // panel from a browser most of the time and the SW just makes it work
    // offline-ish (last-known cache served if the API is down).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'logo.png'],
      manifest: {
        name: 'KyuubiSoft Hytale Panel',
        short_name: 'Hytale Panel',
        description: 'Web-based management for self-hosted Hytale servers',
        theme_color: '#FF6B35',
        background_color: '#1A1D23',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/logo.png', sizes: '192x192', type: 'image/png' },
          { src: '/logo.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Layer the Web Push handlers (push / notificationclick) onto the
        // generated precache SW. public/push-sw.js is copied to the output root.
        importScripts: ['push-sw.js'],
        // The panel UI is a single page app + assets. /api/* is always
        // network-first because mutations must reach the backend.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Self-hosted web fonts are part of the shell, so the PWA renders
        // correctly offline.
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // Not precached: the code editor (Monaco, ~2.6 MB) and the setup wizard
        // are only needed by some users on some pages. They are cached at
        // runtime on first use instead (see below), so a first visit does not
        // download them up front.
        globIgnores: ['**/editor.api-*.js', '**/editor-*.css', '**/SetupWizard-*.{js,css}'],
        runtimeCaching: [
          {
            // Hashed filenames, so a cached copy is never stale.
            urlPattern: /\/assets\/(?:editor\.api-|editor-|SetupWizard-)[^/]+\.(?:js|css)$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'kp-lazy-chunks',
              expiration: { maxEntries: 8, maxAgeSeconds: 90 * 86400 },
            },
          },
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\.(?:png|svg|webp|ico)$/,
            handler: 'CacheFirst',
            options: { cacheName: 'kp-static-assets', expiration: { maxAgeSeconds: 30 * 86400 } },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:18080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
})
