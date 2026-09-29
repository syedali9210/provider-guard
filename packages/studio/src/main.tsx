import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './tokens.css'
import './app.css'

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The public demo only; this branch and the module are removed from every other build.
if (__VERCEL_INSIGHTS__) void import('./insights').then((m) => m.startInsights())
