import { afterEach, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'

import { startCodingBroker, SecretScrubber, type CodingBroker } from './broker'

const CANARY = 'canary-provider-access-never-a-real-token'
const REFRESH = 'canary-refresh-never-a-real-token'
const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, oauth = false) {
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
      auth: { resolve: async () => ({ type: oauth ? 'oauth' : 'api_key', token: CANARY, secrets: [CANARY, REFRESH] }) },
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
  test.each([false, true])('injects only upstream auth and scrubs split chunks for OAuth=%s', async (oauth) => {
    const requests: IncomingMessage['headers'][] = []
    const broker = await fixture((req, res) => {
      requests.push(req.headers)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'set-cookie': CANARY,
        'request-id': `id-${CANARY}`,
        'anthropic-ratelimit-requests-remaining': '9',
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
    'CONNECT example.test:443 HTTP/1.1',
    'GET /v1/messages HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade',
  ])('rejects tunnel or upgrade requests: %s', async (line) => {
    let outbound = 0
    const broker = await fixture((_req, res) => {
      outbound++
      res.end()
    })
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
    expect((await send(broker)).status).toBe(502)
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
