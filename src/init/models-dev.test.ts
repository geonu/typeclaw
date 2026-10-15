import { describe, expect, test } from 'bun:test'

import { curatedOptions, fetchModelOptions } from './models-dev'

const MODELS_DEV_URL = 'https://models.dev/api.json'
const OPENGATEWAY_CATALOG_URL = 'https://apis.opengateway.ai/v1/models'
const OPENGATEWAY_PRICES_URL = 'https://opengateway.ai/api/model-prices'

function routedFetch(routes: Record<string, unknown | Error>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input)
    const value = routes[url]
    if (value === undefined) throw new Error(`unexpected URL: ${url}`)
    if (value instanceof Error) throw value
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('curatedOptions', () => {
  test('returns one entry per (provider, model) pair in KNOWN_PROVIDERS', () => {
    const options = curatedOptions()

    expect(options.length).toBeGreaterThan(0)
    expect(options.every((o) => o.curated)).toBe(true)
    expect(options.some((o) => o.providerId === 'openai')).toBe(true)
    expect(options.some((o) => o.providerId === 'fireworks')).toBe(true)
  })

  test('flags supportsVision based on curated input modality', () => {
    const options = curatedOptions()

    const openaiNano = options.find((o) => o.ref === 'openai/gpt-5.4-nano')
    expect(openaiNano?.supportsVision).toBe(true)
    const glm = options.find((o) => o.ref === 'zai/glm-4.6')
    expect(glm?.supportsVision).toBe(false)
  })
})

describe('fetchModelOptions', () => {
  test('falls back to curated list when fetch throws', async () => {
    // given: a fetch that always rejects (simulates offline init).
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('curated')
    expect(result.warning).toContain('network down')
    expect(result.options.length).toBeGreaterThan(0)
  })

  test('falls back to curated list on non-2xx response', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 502 })) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('curated')
    expect(result.warning).toContain('502')
  })

  test('merges live data with curated entries when fetch succeeds', async () => {
    // given: a stub response with a rival name for one curated model and a new upstream model.
    const stub = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: {
          'gpt-5.4-nano': {
            id: 'gpt-5.4-nano',
            name: 'GPT-5.4 nano (live)',
            reasoning: true,
            limit: { context: 400000, output: 128000 },
          },
          'gpt-6-live': {
            id: 'gpt-6-live',
            name: 'GPT-6 Live',
            reasoning: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            limit: { context: 500000, output: 64000 },
            cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
          },
          invalid: {
            id: '',
            name: 'Invalid',
          },
        },
      },
      'fireworks-ai': {
        id: 'fireworks-ai',
        name: 'Fireworks AI',
        models: {},
      },
    }
    const fetchImpl = (async () =>
      new Response(JSON.stringify(stub), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('models.dev')
    const nano = result.options.find((o) => o.ref === 'openai/gpt-5.4-nano')
    expect(nano?.modelName).toBe('GPT-5.4 nano')
    const live = result.options.find((o) => o.ref === 'openai/gpt-6-live')
    expect(live).toMatchObject({
      modelName: 'GPT-6 Live',
      providerId: 'openai',
      curated: false,
      reasoning: true,
      supportsVision: true,
      contextWindow: 500000,
      maxTokens: 64000,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    })
    expect(result.options.some((o) => o.modelName === 'Invalid')).toBe(false)
    // kimi-k2p6-turbo is curated-only; must still appear even though models.dev didn't list it.
    expect(result.options.some((o) => o.modelId === 'accounts/fireworks/routers/kimi-k2p6-turbo')).toBe(true)
  })

  test('a curated record outranks contradicting models.dev metadata on every field', async () => {
    // The picker has to describe what `resolveModel` will actually serve, and
    // that is always the curated record for a known ref. Upstream disagreeing
    // is the normal case, not an anomaly: models.dev names solar-pro3 with its
    // bare id and caps its output at 8192, where providers.ts says "Solar Pro
    // 3" and 32000.
    const fetchImpl = routedFetch({
      [MODELS_DEV_URL]: {
        openai: {
          id: 'openai',
          name: 'OpenAI',
          models: {
            'gpt-5.4-nano': {
              id: 'gpt-5.4-nano',
              name: 'GPT-5.4 nano (live)',
              reasoning: false,
              modalities: { input: ['text'], output: ['text'] },
              limit: { context: 111111, output: 2222 },
              cost: { input: 9.99, output: 9.99, cache_read: 9.99, cache_write: 9.99 },
            },
          },
        },
      },
      [OPENGATEWAY_CATALOG_URL]: new Error('gateway catalog down'),
      [OPENGATEWAY_PRICES_URL]: new Error('gateway prices down'),
    })

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.options.find((o) => o.ref === 'openai/gpt-5.4-nano')).toMatchObject({
      modelName: 'GPT-5.4 nano',
      reasoning: true,
      supportsVision: true,
      contextWindow: 400000,
      maxTokens: 128000,
      cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
    })
  })

  test('never synthesizes bare models.dev ids onto opengateway, which requires a creator prefix', async () => {
    // given: models.dev listing an openai model that opengateway would only
    // accept as `openai/gpt-6-live`.
    const stub = {
      openai: {
        id: 'openai',
        name: 'OpenAI',
        models: { 'gpt-6-live': { id: 'gpt-6-live', name: 'GPT-6 Live' } },
      },
    }
    const fetchImpl = (async () => new Response(JSON.stringify(stub), { status: 200 })) as unknown as typeof fetch

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.source).toBe('models.dev')
    expect(result.options.some((o) => o.ref === 'openai/gpt-6-live')).toBe(true)
    expect(result.options.some((o) => o.ref === 'opengateway/gpt-6-live')).toBe(false)
    const opengateway = result.options.filter((o) => o.providerId === 'opengateway')
    expect(opengateway.length).toBeGreaterThan(0)
    expect(opengateway.every((o) => o.curated)).toBe(true)
    expect(opengateway.every((o) => o.modelId.includes('/'))).toBe(true)
  })

  test('models.dev failure does not suppress live OpenGateway models', async () => {
    const fetchImpl = routedFetch({
      [MODELS_DEV_URL]: new Error('models.dev down'),
      [OPENGATEWAY_CATALOG_URL]: {
        data: [
          {
            id: 'anthropic/claude-sonnet-5',
            owned_by: 'anthropic',
            status: 'active',
            modalities: { input: ['text'], output: ['text'] },
            endpoints: ['chat_completions'],
          },
        ],
      },
      [OPENGATEWAY_PRICES_URL]: {
        'anthropic/claude-sonnet-5': { inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 },
      },
    })

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.sources).toEqual({ modelsDev: 'unavailable', openGatewayCatalog: 'live', openGatewayPrices: 'live' })
    expect(result.options).toContainEqual(
      expect.objectContaining({
        ref: 'opengateway/anthropic/claude-sonnet-5',
        curated: false,
        modelName: 'Claude Sonnet 5',
        reasoning: true,
        supportsVision: false,
        contextWindow: 1000000,
        maxTokens: 128000,
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      }),
    )
  })

  test('survives a well-formed models.dev envelope carrying a malformed nested model', async () => {
    // Only the root is shape-checked on fetch, so a valid envelope can still
    // smuggle a null model. This used to escape the fallback and crash the
    // whole wizard rather than degrading to the curated list.
    const fetchImpl = routedFetch({
      [MODELS_DEV_URL]: { openai: { models: { broken: null } } },
      [OPENGATEWAY_CATALOG_URL]: new Error('gateway catalog down'),
      [OPENGATEWAY_PRICES_URL]: new Error('gateway prices down'),
    })

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.options.length).toBeGreaterThan(0)
    expect(result.options.some((o) => o.ref === 'opengateway/openai/gpt-5.4-nano')).toBe(true)
  })

  test('maps gateway creator namespaces onto native provider ids when enriching limits', async () => {
    // The gateway says `x-ai`/`moonshotai` where this registry says `xai`/`moonshot`.
    // Neither OpenGateway endpoint publishes a context window, so a missed alias
    // silently drops limits instead of failing loudly.
    const fetchImpl = routedFetch({
      [MODELS_DEV_URL]: new Error('models.dev down'),
      [OPENGATEWAY_CATALOG_URL]: {
        data: [
          {
            id: 'x-ai/grok-4.3',
            owned_by: 'x-ai',
            status: 'active',
            modalities: { input: ['text'], output: ['text'] },
            endpoints: ['chat_completions'],
          },
          {
            id: 'moonshotai/kimi-k2.6',
            owned_by: 'moonshotai',
            status: 'active',
            modalities: { input: ['text'], output: ['text'] },
            endpoints: ['chat_completions'],
          },
        ],
      },
      [OPENGATEWAY_PRICES_URL]: {},
    })

    const result = await fetchModelOptions({ fetchImpl })

    const grok = result.options.find((o) => o.ref === 'opengateway/x-ai/grok-4.3')
    expect(grok?.modelName).toBe('Grok 4.3')
    expect(grok?.contextWindow).toBe(1000000)
    const kimi = result.options.find((o) => o.ref === 'opengateway/moonshotai/kimi-k2.6')
    expect(kimi?.modelName).toBe('Kimi K2.6')
    expect(kimi?.contextWindow).toBe(256000)
  })

  test('OpenGateway failure does not suppress models.dev models', async () => {
    const fetchImpl = routedFetch({
      [MODELS_DEV_URL]: {
        openai: {
          models: {
            'gpt-live': {
              id: 'gpt-live',
              name: 'GPT Live',
              modalities: { input: ['text'], output: ['text'] },
            },
          },
        },
      },
      [OPENGATEWAY_CATALOG_URL]: new Error('gateway catalog down'),
      [OPENGATEWAY_PRICES_URL]: new Error('gateway prices down'),
    })

    const result = await fetchModelOptions({ fetchImpl })

    expect(result.sources).toEqual({
      modelsDev: 'live',
      openGatewayCatalog: 'unavailable',
      openGatewayPrices: 'unavailable',
    })
    expect(result.options).toContainEqual(expect.objectContaining({ ref: 'openai/gpt-live', curated: false }))
  })
})
