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
        // The panel UI is a single page app + assets. /api/* is always
        // network-first because mutations must reach the backend.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        // Monaco-Editor's editor.api chunk is ~2.6 MB; raise the default
        // 2 MiB cap so precache doesn't fail. We accept the larger SW.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
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
