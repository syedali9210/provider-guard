import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

/** jsdom has no matchMedia; tests flip these to emulate user preferences. */
export const media = { reducedMotion: false, dark: false }

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: query.includes('reduced-motion')
      ? media.reducedMotion
      : query.includes('dark')
        ? media.dark
        : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  media.reducedMotion = false
  media.dark = false
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})
