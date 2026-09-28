const warned = new Set<string>()

/** Logs a warning once per process per key. */
export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[provider-guard] ${message}`)
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** @internal test helper */
export function _resetWarnings(): void {
  warned.clear()
}
