import { errorMessage, warnOnce } from './log'

export type ExcludeOptions = {
  /** How long a provider list is fresh. Stale lists are returned at once and refreshed. */
  ttlMs?: number
  onUnavailable?: 'allow-all' | 'throw'
  /** Injectable for tests. */
  fetch?: typeof fetch
  baseURL?: string
}

export class NoProvidersLeftError extends Error {
  override readonly name = 'NoProvidersLeftError'
  constructor(
    readonly modelId: string,
    readonly excluded: string[],
  ) {
    super(
      `Excluding ${excluded.join(', ')} leaves no provider for ${modelId}. Remove at least one of them from the exclude list.`,
    )
  }
}

export class ProviderListUnavailableError extends Error {
  override readonly name = 'ProviderListUnavailableError'
  constructor(
    readonly modelId: string,
    cause: unknown,
  ) {
    super(
      `Could not load the provider list for ${modelId} from the AI Gateway endpoints API (${errorMessage(cause)}). Check the network, or use onUnavailable: 'allow-all' to allow every provider.`,
      { cause },
    )
  }
}

const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh'
const DEFAULT_TTL_MS = 10 * 60_000
/** After a failed fetch, calls answer from what is known instead of refetching every time. */
const FAILURE_BACKOFF_MS = 30_000

type Entry = {
  providers?: string[]
  fetchedAt: number
  retryAt: number
  error?: unknown
  inflight?: Promise<void>
}
const cache = new Map<string, Entry>()

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function assertModelId(modelId: string): void {
  if (!/^[^/\s]+\/\S+$/.test(modelId)) {
    throw new TypeError(`Expected a gateway model id like "zai/glm-5.3-flash", got "${modelId}".`)
  }
}

/** GET {baseURL}/v1/models/{creator}/{model}/endpoints — public, no API key. */
async function fetchProviders(modelId: string, baseURL: string, fetchImpl: typeof fetch) {
  const url = `${baseURL}/v1/models/${modelId.split('/').map(encodeURIComponent).join('/')}/endpoints`
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`)
  const body: unknown = await res.json()
  const endpoints = isObject(body) && isObject(body.data) ? body.data.endpoints : undefined
  if (!Array.isArray(endpoints)) throw new Error(`GET ${url} returned an unexpected shape`)
  const names = endpoints
    .map((e) => (isObject(e) ? e.provider_name : undefined))
    .filter((name): name is string => typeof name === 'string' && name.length > 0)
  if (names.length === 0) throw new Error(`GET ${url} listed no providers`)
  return [...new Set(names)]
}

async function loadEntry(modelId: string, options: ExcludeOptions): Promise<Entry> {
  assertModelId(modelId)
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const key = `${baseURL} ${modelId}`
  let entry = cache.get(key)
  if (!entry) {
    entry = { fetchedAt: 0, retryAt: 0 }
    cache.set(key, entry)
  }
  const current = entry
  const refresh = () => {
    if (Date.now() < current.retryAt) return Promise.resolve()
    current.inflight ??= fetchProviders(modelId, baseURL, options.fetch ?? globalThis.fetch)
      .then(
        (providers) => {
          current.providers = providers
          current.fetchedAt = Date.now()
          current.retryAt = 0
          current.error = undefined
        },
        (error) => {
          // Keep the last known list; remember why the refresh failed and back off.
          current.error = error
          current.retryAt = Date.now() + FAILURE_BACKOFF_MS
        },
      )
      .finally(() => {
        current.inflight = undefined
      })
    return current.inflight
  }
  if (current.providers) {
    // Stale-while-revalidate: answer from cache now, refresh in the background.
    if (Date.now() - current.fetchedAt >= (options.ttlMs ?? DEFAULT_TTL_MS)) void refresh()
    return current
  }
  await refresh()
  return current
}

/** The model's provider slugs, from cache or the public endpoints API; `undefined` if unavailable. */
export async function getProviderList(
  modelId: string,
  options: ExcludeOptions = {},
): Promise<string[] | undefined> {
  return (await loadEntry(modelId, options)).providers
}

/**
 * Builds `providerOptions.gateway` that keeps every provider of `modelId` except `providers`,
 * including providers added later. Spread the result into `providerOptions.gateway`.
 */
export async function exclude(
  modelId: string,
  providers: string[],
  options: ExcludeOptions = {},
): Promise<{ only?: string[] }> {
  const entry = await loadEntry(modelId, options)
  const list = entry.providers
  if (!list) {
    if (options.onUnavailable === 'throw') {
      throw new ProviderListUnavailableError(modelId, entry.error)
    }
    warnOnce(
      `exclude-unavailable:${modelId}`,
      `Could not load the provider list for ${modelId} (${errorMessage(entry.error)}). exclude() returned no restriction, so every provider stays eligible. Pass onUnavailable: 'throw' to fail instead.`,
    )
    return {}
  }

  const lower = (s: string) => s.toLowerCase()
  const known = new Set(list.map(lower))
  const excluded = new Set(providers.map(lower))
  for (const p of providers) {
    if (!known.has(lower(p))) {
      warnOnce(
        `exclude-unknown:${modelId}:${lower(p)}`,
        `"${p}" does not serve ${modelId}, so there is nothing to exclude. Providers for this model: ${list.join(', ')}.`,
      )
    }
  }
  const remaining = list.filter((p) => !excluded.has(lower(p)))
  if (remaining.length === 0) throw new NoProvidersLeftError(modelId, providers)
  return remaining.length === list.length ? {} : { only: remaining }
}

/** @internal test helper */
export function _clearProviderCache(): void {
  cache.clear()
}
