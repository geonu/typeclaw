import { afterEach, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'

import type { CodingAgentAuthResolver, CodingAgentProvider } from '@/secrets/coding-agent-auth'

import { startCodingBroker, SecretScrubber, type CodingBroker } from './broker'

const CANARY = 'canary-provider-access-never-a-real-token'
const REFRESH = 'canary-refresh-never-a-real-token'
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  oauth = false,
  provider: CodingAgentProvider = 'anthropic',
  auth?: CodingAgentAuthResolver,
) {
  const upstream = createServer(handler)
  const listening = once(upstream, 'listening')
  upstream.listen(0, '127.0.0.1')
  await listening
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.close(() => resolve())
        upstream.closeAllConnections()
      }),
  )
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('No upstream address')
  const broker = await startCodingBroker(
    {
      provider,
      auth: auth ?? {
        resolve: async () =>
          provider === 'openai-codex'
            ? {
                provider,
                type: 'oauth',
                token: CANARY,
                accountId: 'trusted-account',
                secrets: [CANARY, REFRESH, 'id-token-canary'],
              }
            : { provider, type: oauth ? 'oauth' : 'api_key', token: CANARY, secrets: [CANARY, REFRESH] },
      },
      allowedModels: ['primary', 'helper'],
      deadline: Date.now() + 60_000,
    },
    { upstream: new URL(`http://127.0.0.1:${address.port}`) },
  )
  cleanup.push(() => broker.close())
  return broker
}

function send(
  broker: CodingBroker,
  path = '/v1/messages',
  options: { model?: string; headers?: Record<string, string>; method?: string; body?: string } = {},
) {
  return new Promise<{ status: number; text: string; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const req = request(
      broker.baseUrl,
      {
        path,
        method: options.method ?? 'POST',
        headers: {
          authorization: `Bearer ${broker.capability}`,
          'content-type': 'application/json',
          ...options.headers,
        },
      },
      async (res) => {
        const parts: Buffer[] = []
        for await (const chunk of res) parts.push(Buffer.from(chunk))
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString(), headers: res.headers })
      },
    )
    req.on('error', reject)
    req.end(
      options.body ??
        JSON.stringify({
          model: options.model ?? 'primary',
          messages: [],
          system: [{ type: 'text', text: 'attribution' }],
        }),
    )
  })
}

describe('coding inference broker', () => {
  test('Codex rejects account and destination spoofing while subsequent Responses streaming still works', async () => {
    const seen: Array<{ target: string; headers: IncomingMessage['headers']; body: string }> = []
    const broker = await fixture(
      (req, res) => {
        let body = ''
        req.on('data', (part) => {
          body += part.toString()
        })
        req.on('end', () => {
          seen.push({ target: req.url ?? '', headers: req.headers, body })
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'set-cookie': CANARY,
            'x-request-id': `request-${CANARY}`,
            'x-ratelimit-remaining-requests': '9',
            [`x-ratelimit-${CANARY}`]: '1',
          })
          res.write(`data: {"type":"response.output_text.delta","delta":"${CANARY.slice(0, 11)}`)
          res.write(`${CANARY.slice(11)} ${REFRESH} id-token-`)
          res.end('canary 완료했습니다"}\n\ndata: {"type":"response.completed"}\n\n')
        })
      },
      true,
      'openai-codex',
    )
    for (const path of [
      '/v1/messages',
      '/v1/responses/compact',
      '/v1/responses/',
      '/v1/../v1/responses',
      '/v1/%72esponses',
      '/v1/responses?beta=true',
      '/v1/responses?',
      '/token',
      '/refresh',
      'https://example.test/v1/responses',
    ])
      expect((await send(broker, path)).status).toBe(400)
    for (const name of [
      'chatgpt-account-id',
      'openai-organization',
      'openai-project',
      'proxy-authorization',
      'forwarded',
    ]) {
      expect((await send(broker, '/v1/responses', { headers: { [name]: 'spoof' } })).status).toBe(400)
    }
    expect((await send(broker, '/v1/responses', { model: 'wrong-model' })).status).toBe(400)
    expect((await send(broker, '/v1/responses', { method: 'GET' })).status).toBe(400)
    expect((await send(broker, '/v1/responses', { headers: { authorization: 'Bearer revoked' } })).status).toBe(401)
    expect(
      (await send(broker, '/v1/responses', { body: '{"model":"primary","base_url":"https://example.test"}' })).status,
    ).toBe(400)
    expect(seen).toHaveLength(0)
    const body = JSON.stringify({
      model: 'primary',
      input: [{ role: 'user', content: '한국어 요청' }],
      store: false,
      stream: true,
    })
    const reply = await send(broker, '/v1/responses', {
      body,
      headers: { cookie: 'child-cookie', 'x-api-key': 'child-key', originator: 'codex_cli_rs' },
    })
    expect(reply.status).toBe(200)
    expect(reply.text).toContain('완료했습니다')
    expect(reply.text).toContain('response.completed')
    for (const canary of [CANARY, REFRESH, 'id-token-canary', broker.capability])
      expect(JSON.stringify(reply)).not.toContain(canary)
    expect(reply.headers['set-cookie']).toBeUndefined()
    expect(reply.headers['x-ratelimit-remaining-requests']).toBe('9')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.target).toBe('/backend-api/codex/responses')
    expect(seen[0]?.body).toBe(body)
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${CANARY}`)
    expect(seen[0]?.headers['chatgpt-account-id']).toBe('trusted-account')
    expect(seen[0]?.headers.originator).toBe('codex_cli_rs')
    for (const name of ['cookie', 'x-api-key', 'anthropic-beta']) expect(seen[0]?.headers[name]).toBeUndefined()
  })

  test('Codex refresh retries once before streaming and scrubs both token generations', async () => {
    let requests = 0
    const resolves: unknown[] = []
    const broker = await fixture(
      (req, res) => {
        requests++
        if (requests === 1) {
          expect(req.headers.authorization).toBe(`Bearer ${CANARY}`)
          res.writeHead(401).end(CANARY)
        } else {
          expect(req.headers.authorization).toBe('Bearer rotated-canary')
          expect(req.headers['chatgpt-account-id']).toBe('rotated-account')
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(`data: ${CANARY} rotated-canary ${REFRESH}\n\n`)
        }
      },
      true,
      'openai-codex',
      {
        resolve: async (_signal, rejected, provider) => {
          resolves.push({ provider, rejected: rejected?.token })
          return {
            provider: 'openai-codex',
            type: 'oauth',
            token: rejected ? 'rotated-canary' : CANARY,
            accountId: rejected ? 'rotated-account' : 'trusted-account',
            secrets: rejected ? ['rotated-canary', REFRESH] : [CANARY, REFRESH],
          }
        },
      },
    )
    const reply = await send(broker, '/v1/responses')
    expect(reply.status).toBe(200)
    expect(resolves).toEqual([
      { provider: 'openai-codex', rejected: undefined },
      { provider: 'openai-codex', rejected: CANARY },
    ])
    expect(requests).toBe(2)
    for (const canary of [CANARY, REFRESH, 'rotated-canary']) expect(reply.text).not.toContain(canary)
  })

  test.each([302, 401, 429, 500])(
    'Codex normalizes upstream %s without reflecting auth or redirect headers',
    async (status) => {
      let requests = 0
      const broker = await fixture(
        (_req, res) => {
          requests++
          res.writeHead(status, { location: `http://example.test/${CANARY}`, 'www-authenticate': REFRESH })
          res.end(`${CANARY} ${REFRESH}`)
        },
        true,
        'openai-codex',
      )
      const reply = await send(broker, '/v1/responses')
      expect(reply.status).toBe(status === 401 ? 401 : status === 429 ? 429 : 502)
      expect(requests).toBe(status === 401 ? 2 : 1)
      for (const canary of [CANARY, REFRESH]) expect(JSON.stringify(reply)).not.toContain(canary)
      expect(reply.headers.location).toBeUndefined()
      expect(reply.headers['www-authenticate']).toBeUndefined()
    },
  )

  test.each([false, true])('injects only upstream auth and scrubs split chunks for OAuth=%s', async (oauth) => {
    const requests: IncomingMessage['headers'][] = []
    const broker = await fixture((req, res) => {
      requests.push(req.headers)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'set-cookie': CANARY,
        'request-id': `id-${CANARY}`,
        'anthropic-ratelimit-requests-remaining': '9',
        [`anthropic-ratelimit-${CANARY}`]: '1',
      })
      res.write(`data: ${CANARY.slice(0, 12)}`)
      res.end(`${CANARY.slice(12)} ${REFRESH}\n\ndata: 완료했습니다\n\n`)
    }, oauth)
    const result = await send(broker, '/v1/messages?beta=true', {
      headers: {
        'anthropic-beta': 'feature-test',
        cookie: 'untrusted',
        'x-api-key': 'untrusted',
      },
    })
    expect(result.status).toBe(200)
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(JSON.stringify(result)).not.toContain(REFRESH)
    expect(result.text).toContain('완료했습니다')
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(requests[0]?.cookie).toBeUndefined()
    expect(requests[0]?.authorization).toBe(oauth ? `Bearer ${CANARY}` : undefined)
    expect(requests[0]?.['x-api-key']).toBe(oauth ? undefined : CANARY)
    if (oauth) expect(requests[0]?.['anthropic-beta']).toContain('feature-test,claude-code-20250219,oauth-2025-04-20')
  })

  test('rejects malformed operations without disabling later authorized requests', async () => {
    let outbound = 0
    const broker = await fixture((_req, res) => {
      outbound++
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    for (const path of [
      '/token',
      '/v1/responses',
      '/v1/messages/',
      '/v1/../v1/messages',
      '/v1/%6dessages',
      '/v1/messages?other=true',
      '/v1/messages?beta=true&beta=true',
      'http://example.test/v1/messages',
    ]) {
      expect((await send(broker, path)).status).toBe(400)
    }
    expect((await send(broker, '/v1/messages', { model: 'unallowed' })).status).toBe(400)
    expect((await send(broker, '/v1/messages', { headers: { authorization: 'Bearer invalid' } })).status).toBe(401)
    expect((await send(broker, '/v1/messages', { method: 'GET' })).status).toBe(400)
    for (const header of [
      'chatgpt-account-id',
      'anthropic-organization-id',
      'x-forwarded-host',
      'proxy-authorization',
    ]) {
      expect((await send(broker, '/v1/messages', { headers: { [header]: 'spoof' } })).status).toBe(400)
    }
    expect(
      (await send(broker, '/v1/messages', { body: '{"model":"primary","upstream":"http://example.test"}' })).status,
    ).toBe(400)
    expect(outbound).toBe(0)
    expect((await send(broker, '/v1/messages/count_tokens', { model: 'helper' })).status).toBe(200)
    expect(outbound).toBe(1)
  })

  test('never follows redirects or reflects upstream error bodies', async () => {
    let hits = 0
    const broker = await fixture((_req, res) => {
      hits++
      res.writeHead(302, { location: `http://example.test/${CANARY}`, 'www-authenticate': CANARY })
      res.end(CANARY)
    })
    const result = await send(broker)
    expect(result.status).toBe(502)
    expect(JSON.stringify(result)).not.toContain(CANARY)
    expect(hits).toBe(1)
  })

  test.each([
    ['anthropic', 'CONNECT example.test:443 HTTP/1.1'],
    ['anthropic', 'GET /v1/messages HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade'],
    ['openai-codex', 'CONNECT example.test:443 HTTP/1.1'],
    ['openai-codex', 'GET /v1/responses HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade'],
  ] as const)('%s rejects tunnel or upgrade requests: %s', async (provider, line) => {
    let outbound = 0
    const broker = await fixture(
      (_req, res) => {
        outbound++
        res.end()
      },
      false,
      provider,
    )
    const socket = connect(Number(new URL(broker.baseUrl).port), '127.0.0.1')
    const ended = once(socket, 'end')
    let reply = ''
    socket.on('data', (chunk) => {
      reply += chunk.toString()
    })
    socket.write(`${line}\r\nHost: localhost\r\nAuthorization: Bearer ${broker.capability}\r\n\r\n`)
    await ended
    socket.destroy()
    expect(reply).toMatch(/HTTP\/1.1 (400|405)/)
    expect(outbound).toBe(0)
    expect((await send(broker, provider === 'anthropic' ? '/v1/messages' : '/v1/responses')).status).toBe(502)
    expect(outbound).toBe(1)
  })

  test('revokes capabilities and closes the listener idempotently', async () => {
    const broker = await fixture((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'))
    await broker.close()
    await broker.close()
    await expect(send(broker)).rejects.toThrow()
  })

  test('stream scrubber preserves prefixes and overlapping chunk boundaries', () => {
    const scrubber = new SecretScrubber(['abcdefgh', 'ijk'])
    expect(scrubber.push('before abcd') + scrubber.push('efgh i') + scrubber.push('jk after', true)).toBe(
      'before [redacted] [redacted] after',
    )
  })
})
