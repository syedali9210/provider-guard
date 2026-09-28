import { defineConfig, devices } from '@playwright/test'

const PORT = 4748

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      // PW_CHANNEL=msedge (or chrome) drives an installed browser instead of Playwright's download.
      use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined },
    },
  ],
  // The public demo: the static replay build, served as Vercel would serve it.
  webServer: {
    command: `pnpm exec vite preview --outDir dist-replay --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
