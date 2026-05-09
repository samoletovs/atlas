import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'atlas — personal teacher',
        short_name: 'atlas',
        description: 'Lessons curated from your AI-accelerated building',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Critical: never let the SW intercept auth redirects or API auth.
        // Without this, /.auth/login/* gets served from the index.html cache
        // and the browser never follows the 302 to the OAuth provider.
        navigateFallbackDenylist: [/^\/\.auth\//, /^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /\/api\/lessons.*$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'atlas-api-lessons',
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
