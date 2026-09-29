// Vercel Web Analytics and Speed Insights, for the public demo only. main.tsx loads this module
// when __VERCEL_INSIGHTS__ is true. Every other build, including the Studio in the npm package,
// leaves it out, so provider-guard itself never sends anything.
import { inject } from '@vercel/analytics'
import { injectSpeedInsights } from '@vercel/speed-insights'

export function startInsights() {
  inject({ mode: 'production', framework: 'vite' })
  injectSpeedInsights({ framework: 'vite' })
}
