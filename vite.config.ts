import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { LESSON_API_CACHE_PATTERN } from './src/lib/apiRoutes.ts';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'atlas — personal teacher',
        short_name: 'atlas',
        description: 'Lessons curated from your AI-accelerated building',
        theme_color: '#111722',
        background_color: '#111722',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Take over immediately on update so users don't get stuck on a
        // cached broken bundle. Combined with `registerType: 'autoUpdate'`,
        // this means new builds are live on the next reload (no 2-reload
        // dance, no manual SW unregister).
        skipWaiting: true,
        clientsClaim: true,
        // Critical: never let the SW intercept auth redirects or API auth.
        // Without this, /.auth/login/* gets served from the index.html cache
        // and the browser never follows the 302 to the OAuth provider.
        navigateFallbackDenylist: [/^\/\.auth\//, /^\/api\//],
        runtimeCaching: [
          {
            urlPattern: LESSON_API_CACHE_PATTERN,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'atlas-api-lessons',
              cacheableResponse: { statuses: [200] },
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:7071',
      '/.auth': 'http://localhost:7071',
    },
  },
});
