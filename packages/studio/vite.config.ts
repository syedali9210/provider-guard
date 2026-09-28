import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// `geist` only exports next/font loaders; its .woff2 files live next to them in dist/fonts.
const geistFonts = join(dirname(fileURLToPath(import.meta.resolve('geist/font/sans'))), 'fonts')

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Pure report/stat helpers and record types are shared with the CLI, straight from source.
      '@core': fileURLToPath(new URL('../core/src', import.meta.url)),
      '@geist-fonts': geistFonts,
    },
  },
  build: { target: 'es2022', assetsInlineLimit: 0 },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
  },
})
