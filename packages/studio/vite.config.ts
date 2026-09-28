import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

// `geist` only exports next/font loaders; its .woff2 files live next to them in dist/fonts.
const geistFonts = join(dirname(fileURLToPath(import.meta.resolve('geist/font/sans'))), 'fonts')

const DEMO_URL = 'https://provider-guard-demo.vercel.app'
// Made by e2e/pitch.spec.ts.
const ogImage = fileURLToPath(new URL('../../docs/og.png', import.meta.url))

/** The public demo only: link-preview tags and image, so a shared demo link shows a card. */
function linkPreview(): Plugin {
  const meta = {
    'og:type': 'website',
    'og:url': DEMO_URL,
    'og:title': 'provider-guard: catch AI responses that bill tokens and deliver nothing',
    'og:description':
      "The gateway catches errors. provider-guard catches successes that aren't. A replay of real calls from vercel/ai#20932 and #21207.",
    'og:image': `${DEMO_URL}/og.png`,
    'og:image:width': '1200',
    'og:image:height': '630',
    'twitter:card': 'summary_large_image',
  }
  return {
    name: 'link-preview',
    transformIndexHtml: () =>
      Object.entries(meta).map(([key, content]) => ({
        tag: 'meta',
        attrs: key.startsWith('og:') ? { property: key, content } : { name: key, content },
        injectTo: 'head' as const,
      })),
    generateBundle() {
      if (!existsSync(ogImage)) return
      this.emitFile({ type: 'asset', fileName: 'og.png', source: readFileSync(ogImage) })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), mode === 'replay' && linkPreview()],
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
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
    setupFiles: ['./test/setup.ts'],
  },
}))
