/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// https://vite.dev/config/
export default defineConfig({
  // La app vive en https://jean-carlos-declama.github.io/martina/
  base: '/martina/',
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: {
    // iPads con iPadOS 14 o más nuevo (Safari 14).
    target: ['es2020', 'safari14'],
  },
  plugins: [
    react(),
    VitePWA({
      // Avisa de la versión nueva y se instala cuando ella toca "Actualizar" (no a mitad de una venta).
      registerType: 'prompt',
      includeAssets: ['favicon-64.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Martina',
        short_name: 'Martina',
        description: 'Tienda, inventario y lotería de Martina',
        lang: 'es',
        start_url: '/martina/',
        scope: '/martina/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f5f4f8',
        theme_color: '#6d28d9',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Todo lo de la app queda guardado en el iPad: funciona sin internet.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
  },
})
