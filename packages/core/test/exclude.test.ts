import type { GatewayProviderOptions } from '@ai-sdk/gateway'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  _clearProviderCache,
  exclude,
  getProviderList,
  NoProvidersLeftError,
  ProviderListUnavailableError,
} from '../src/exclude'
import { _resetWarnings } from '../src/log'
import { endpointsFixture } from './helpers'

const MODEL = 'zai/glm-5.3-flash'
const endpoints = (...providers: string[]) => ({
  data: { id: MODEL, endpoints: providers.map((provider_name) => ({ provider_name, status: 0 })) },
})
const json = (body: unknown) => async () => Response.json(body)

beforeEach(() => {
  _resetWarnings()
  _clearProviderCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('exclude()', () => {
  test('keeps every other provider, in the API order, from the real endpoints shape', async () => {
    const fetch = vi.fn(json(endpointsFixture()))

    const result = await exclude(MODEL, ['baseten'], { fetch })

    expect(result.only).toHaveLength(18)
    expect(result.only).not.toContain('baseten')
    expect(result.only?.slice(0, 3)).toEqual(['boundless', 'deepinfra', 'digitalocean'])
    expect(fetch).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v1/models/zai/glm-5.3-flash/endpoints',
      { headers: { accept: 'application/json' } },
    )
  })

  test('the result spreads into providerOptions.gateway', async () => {
    const fetch = vi.fn(json(endpoints('baseten', 'zai')))
    const gateway: GatewayProviderOptions = {
      sort: 'cost',
      ...(await exclude(MODEL, ['baseten'], { fetch })),
    }
    expect(gateway).toEqual({ sort: 'cost', only: ['zai'] })
  })

  test('cache hit: a second call within the TTL does not fetch', async () => {
    const fetch = vi.fn(json(endpoints('baseten', 'zai', 'fireworks')))
    await exclude(MODEL, ['baseten'], { fetch })
    expect(await exclude(MODEL, ['zai'], { fetch })).toEqual({ only: ['baseten', 'fireworks'] })
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('stale-while-revalidate: the stale list answers at once, the refresh lands later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetch = vi
      .fn()
      .mockImplementationOnce(json(endpoints('baseten', 'zai')))
      .mockImplementationOnce(json(endpoints('baseten', 'zai', 'fireworks')))
    const opts = { fetch, ttlMs: 1000 }
    expect(await exclude(MODEL, ['baseten'], opts)).toEqual({ only: ['zai'] })

    vi.setSystemTime(Date.now() + 1500)

    expect(await exclude(MODEL, ['baseten'], opts)).toEqual({ only: ['zai'] })
    await vi.waitFor(async () =>
      expect(await exclude(MODEL, ['baseten'], opts)).toEqual({ only: ['zai', 'fireworks'] }),
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('concurrent calls share one fetch', async () => {
    let respond!: (res: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          respond = resolve
        }),
    )
    const pending = Promise.all([
      exclude(MODEL, ['baseten'], { fetch }),
      exclude(MODEL, ['zai'], { fetch }),
      getProviderList(MODEL, { fetch }),
    ])
    respond(Response.json(endpoints('baseten', 'zai', 'fireworks')))

    expect(await pending).toEqual([
      { only: ['zai', 'fireworks'] },
      { only: ['baseten', 'fireworks'] },
      ['baseten', 'zai', 'fireworks'],
    ])
    expect(fetch).toHaveBeenCalledOnce()
  })

  test('a failed refresh keeps using the last known list', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const fetch = vi
      .fn()
      .mockImplementationOnce(json(endpoints('baseten', 'zai')))
      .mockImplementation(async () => new Response('bad gateway', { status: 502 }))
    const opts = { fetch, ttlMs: 1000 }
    await exclude(MODEL, ['baseten'], opts)
    vi.setSystemTime(Date.now() + 5000)

    expect(await exclude(MODEL, ['baseten'], opts)).toEqual({ only: ['zai'] })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(await exclude(MODEL, ['baseten'], opts)).toEqual({ only: ['zai'] })
    // Backs off after a failure instead of refetching on every call.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  test('without a last known list, a failure allows every provider and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })

    expect(await exclude(MODEL, ['baseten'], { fetch })).toEqual({})
    expect(await exclude(MODEL, ['baseten'], { fetch })).toEqual({})

    expect(fetch).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('fetch failed')
    expect(warn.mock.calls[0]?.[0]).toContain("onUnavailable: 'throw'")
  })

  test('the list is fetched again once the failure back-off has passed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => new Response('down', { status: 503 }))
      .mockImplementationOnce(json(endpoints('baseten', 'zai')))

    expect(await exclude(MODEL, ['baseten'], { fetch })).toEqual({})
    vi.setSystemTime(Date.now() + 31_000)
    expect(await exclude(MODEL, ['baseten'], { fetch })).toEqual({ only: ['zai'] })
  })

  test("onUnavailable: 'throw' throws ProviderListUnavailableError with the cause", async () => {
    const cause = new TypeError('fetch failed')
    const fetch = vi.fn(async () => {
      throw cause
    })

    const error = await exclude(MODEL, ['baseten'], { fetch, onUnavailable: 'throw' }).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(ProviderListUnavailableError)
    expect(error).toMatchObject({ name: 'ProviderListUnavailableError', modelId: MODEL, cause })
    expect((error as Error).message).toContain(MODEL)
  })

  test.each([
    ['a non-2xx status', async () => new Response('nope', { status: 404 })],
    ['an unexpected shape', json({ endpoints: [] })],
    ['an empty provider list', json(endpoints())],
  ])('treats %s as unavailable', async (_label, impl) => {
    const fetch = vi.fn(impl)
    await expect(exclude(MODEL, [], { fetch, onUnavailable: 'throw' })).rejects.toBeInstanceOf(
      ProviderListUnavailableError,
    )
  })

  test('slugs compare case-insensitively and keep the API spelling', async () => {
    const fetch = vi.fn(json(endpoints('Baseten', 'zai')))
    expect(await exclude(MODEL, ['BASETEN'], { fetch })).toEqual({ only: ['zai'] })
  })

  test('an unknown slug warns once and restricts nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetch = vi.fn(json(endpoints('baseten', 'zai')))

    expect(await exclude(MODEL, ['basetne'], { fetch })).toEqual({})
    expect(await exclude(MODEL, ['basetne'], { fetch })).toEqual({})

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('"basetne" does not serve zai/glm-5.3-flash')
  })

  test('excluding every provider throws NoProvidersLeftError naming the model and list', async () => {
    const fetch = vi.fn(json(endpoints('baseten', 'zai')))
    const error = await exclude(MODEL, ['baseten', 'ZAI'], { fetch }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(NoProvidersLeftError)
    expect(error).toMatchObject({ modelId: MODEL, excluded: ['baseten', 'ZAI'] })
    expect((error as Error).message).toBe(
      'Excluding baseten, ZAI leaves no provider for zai/glm-5.3-flash. Remove at least one of them from the exclude list.',
    )
  })

  test('single-provider model: excluding it throws, excluding nothing returns {}', async () => {
    const fetch = vi.fn(json(endpoints('zai')))
    await expect(exclude(MODEL, ['zai'], { fetch })).rejects.toBeInstanceOf(NoProvidersLeftError)
    expect(await exclude(MODEL, [], { fetch })).toEqual({})
  })

  test('uses baseURL, and caches per base URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(json(endpoints('a', 'b')))
    await exclude(MODEL, ['a'], { fetch, baseURL: 'https://gateway.example.test/' })
    await exclude(MODEL, ['a'], { fetch })
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      'https://gateway.example.test/v1/models/zai/glm-5.3-flash/endpoints',
      'https://ai-gateway.vercel.sh/v1/models/zai/glm-5.3-flash/endpoints',
    ])
  })

  test('rejects a model id without a creator', async () => {
    await expect(exclude('glm-5.3-flash', [])).rejects.toThrow(TypeError)
  })
})

// Opt-in: the only live call allowed anywhere is this public, unauthenticated endpoint (PRD §0.5).
test.runIf(process.env.PG_LIVE_PUBLIC === '1')(
  'live: the public endpoints API lists providers without an API key',
  async () => {
    const providers = await getProviderList(MODEL)
    expect(providers?.length).toBeGreaterThan(1)
    expect(await exclude(MODEL, [providers?.[0] ?? ''])).toHaveProperty('only')
  },
)
