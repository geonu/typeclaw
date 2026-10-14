import { afterEach, expect, test } from 'bun:test'
import { zstdCompressSync } from 'node:zlib'

import type { CodingAgentAuthResolver, CodingAgentProvider } from '@/secrets/coding-agent-auth'

import { startCodingBroker, type CodingBroker } from './broker'

const access = 'omo-access-canary-not-a-real-token'
const refresh = 'omo-refresh-canary-not-a-real-token'
const closes: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})

async function setup(provider: CodingAgentProvider, oauth = true, engine: 'omo' | 'codex' | 'claude' = 'omo') {
  const seen: Array<{ path: string; headers: Headers; body: unknown }> = []
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      seen.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.json() })
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const text of [`data: {"text":"${access.slice(0, 9)}`, `${access.slice(9)} ${refresh} 完了"}\n\n`])
              controller.enqueue(new TextEncoder().encode(text))
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream', 'x-request-id': access, 'set-cookie': refresh } },
      )
    },
  })
  closes.push(() => upstream.stop(true))
  const auth: CodingAgentAuthResolver = {
    resolve: async () =>
      provider === 'anthropic'
        ? { provider, type: oauth ? 'oauth' : 'api_key', token: access, secrets: [access, refresh] }
        : { provider, type: 'oauth', token: access, accountId: 'trusted-account', secrets: [access, refresh] },
  }
  const broker = await startCodingBroker(
    { provider, engine, auth, allowedModels: ['selected'], deadline: Date.now() + 60_000 },
    { upstream: new URL(upstream.url) },
  )
  closes.push(() => broker.close())
  return { broker, seen }
}

const body = JSON.stringify({ model: 'selected', stream: true, store: false, input: [] })
function send(
  broker: CodingBroker,
  options: { path?: string; body?: string | Uint8Array; headers?: Record<string, string> } = {},
) {
  return fetch(broker.baseUrl + (options.path ?? '/v1/codex/responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.capability}`, ...options.headers },
    body:
      typeof options.body === 'string'
        ? options.body
        : Uint8Array.from(options.body ?? zstdCompressSync(Buffer.from(body))),
  })
}

test('decodes bounded OmO Codex requests and rebuilds only exact protocol headers', async () => {
  const { broker, seen } = await setup('openai-codex')
  const response = await send(broker, {
    headers: {
      'content-encoding': 'zstd',
      'openai-beta': 'responses=experimental',
      'session-id': 'session',
      'thread-id': 'thread',
      'x-client-request-id': 'request',
      'x-codex-routing-hint': 'model=selected',
      'x-arbitrary': 'must-not-forward',
      originator: 'omo',
    },
  })
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text).toContain('完了')
  for (const secret of [access, refresh, broker.capability]) expect(text).not.toContain(secret)
  expect(response.headers.get('x-request-id')).toBe('[redacted]')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(seen).toHaveLength(1)
  expect(seen[0]?.path).toBe('/backend-api/codex/responses')
  expect(seen[0]?.body).toEqual(JSON.parse(body))
  const headers = seen[0]?.headers
  expect(headers?.get('authorization')).toBe(`Bearer ${access}`)
  expect(headers?.get('chatgpt-account-id')).toBe('trusted-account')
  expect(headers?.get('content-encoding')).toBeNull()
  expect(headers?.get('x-arbitrary')).toBeNull()
  for (const key of [
    'openai-beta',
    'session-id',
    'thread-id',
    'x-client-request-id',
    'x-codex-routing-hint',
    'originator',
  ])
    expect(headers?.get(key)).not.toBeNull()
})

test('rejects malformed compression, expansion, spoofing and wrong models without disabling valid work', async () => {
  const { broker, seen } = await setup('openai-codex')
  const rejected: NonNullable<Parameters<typeof send>[1]>[] = [
    { headers: { 'content-encoding': 'gzip' } },
    { headers: { 'content-encoding': 'zstd' }, body: 'not zstd' },
    { headers: { 'content-encoding': 'zstd' }, body: zstdCompressSync(Buffer.alloc(32 * 1024 * 1024 + 1)) },
    { headers: { 'content-encoding': 'zstd' }, body: zstdCompressSync(Buffer.from('{"model":"other"}')) },
    { headers: { 'content-encoding': 'zstd', 'chatgpt-account-id': 'child-account' } },
    {
      headers: { 'content-encoding': 'zstd' },
      body: zstdCompressSync(Buffer.from('{"model":"selected","upstream":"https://example.test"}')),
    },
    { path: '/v1/responses', body },
    { path: '/v1/codex/responses/compact', body },
    { path: '/v1/codex/responses?beta=true', body },
    { path: '/v1/messages', body },
  ]
  for (const request of rejected) {
    const response = await send(broker, request)
    expect([400, 413]).toContain(response.status)
    expect(await response.text()).not.toContain(access)
  }
  expect(seen).toHaveLength(0)
  const valid = await send(broker, { headers: { 'content-encoding': 'zstd' } })
  expect(valid.status).toBe(200)
  await valid.text()
  expect(seen).toHaveLength(1)
})

test.each(['codex', 'claude'] as const)('does not widen the %s broker profile', async (engine) => {
  const provider = engine === 'codex' ? 'openai-codex' : 'anthropic'
  const { broker, seen } = await setup(provider, true, engine)
  expect(broker.capability).not.toStartWith('sk-ant-oat01-')
  expect((await send(broker, { headers: { 'content-encoding': 'zstd' } })).status).toBe(400)
  const path = engine === 'codex' ? '/v1/responses' : '/v1/messages'
  expect((await send(broker, { path, headers: { 'content-encoding': 'zstd' } })).status).toBe(400)
  const valid = await send(broker, { path, body })
  expect(valid.status).toBe(200)
  await valid.text()
  expect(seen).toHaveLength(1)
})

test.each([true, false])('uses an OAuth-shaped local capability only for OmO Anthropic OAuth=%s', async (oauth) => {
  const { broker, seen } = await setup('anthropic', oauth)
  expect(broker.capability.startsWith('sk-ant-oat01-')).toBe(oauth)
  expect(broker.capability).not.toContain(access)
  const payload = { model: 'selected', messages: [], system: [{ type: 'text', text: 'client identity' }] }
  const response = await send(broker, {
    path: '/v1/messages?beta=true',
    body: JSON.stringify(payload),
    headers: {
      'x-api-key': broker.capability,
      'anthropic-beta': 'client-feature',
      'user-agent': 'claude-cli/2.1.299',
    },
  })
  expect(response.status).toBe(200)
  await response.text()
  expect(seen[0]?.body).toEqual(payload)
  expect(seen[0]?.headers.get('user-agent')).toBe('claude-cli/2.1.299')
  expect(seen[0]?.headers.get(oauth ? 'authorization' : 'x-api-key')).toBe(oauth ? `Bearer ${access}` : access)
  expect(seen[0]?.headers.get(oauth ? 'x-api-key' : 'authorization')).toBeNull()
  expect(JSON.stringify(seen[0]?.body)).not.toContain(broker.capability)
  if (oauth) {
    expect(seen[0]?.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(seen[0]?.headers.get('x-app')).toBe('cli')
  }
})
