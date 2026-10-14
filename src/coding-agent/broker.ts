import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'

import type { CodingAgentAuth, CodingAgentAuthResolver, CodingAgentProvider } from '@/secrets/coding-agent-auth'

import { readCodingBody } from './broker-body'

const MAX_STREAMS = 4
const ANTHROPIC_ROUTES = new Set(['/v1/messages', '/v1/messages/count_tokens'])
const ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta', 'user-agent', 'x-app'] as const
const CODEX_HEADERS = ['user-agent', 'originator', 'version', 'session_id', 'x-codex-turn-metadata'] as const
const OMO_CODEX_HEADERS = [
  ...CODEX_HEADERS,
  'openai-beta',
  'session-id',
  'thread-id',
  'x-client-request-id',
  'x-codex-routing-hint',
] as const
const REJECTED_HEADERS = [
  'proxy-authorization',
  'forwarded',
  'x-forwarded-host',
  'x-forwarded-for',
  'anthropic-organization-id',
  'anthropic-workspace-id',
  'x-organization-id',
  'x-workspace-id',
  'chatgpt-account-id',
  'openai-organization',
  'openai-project',
] as const

export class SecretScrubber {
  private pending = ''
  constructor(private readonly secrets: readonly string[]) {}

  push(text: string, final = false): string {
    this.pending += text
    const secrets = this.secrets.filter(Boolean)
    const keep = Math.max(1, ...secrets.map((s) => s.length)) - 1
    let index = 0
    let output = ''
    while (index < this.pending.length && (final || index < this.pending.length - keep)) {
      const secret = secrets.find((value) => this.pending.startsWith(value, index))
      if (secret) {
        output += '[redacted]'
        index += secret.length
      } else {
        output += this.pending[index]
        index++
      }
    }
    this.pending = this.pending.slice(index)
    return output
  }
}

export type CodingBroker = {
  readonly baseUrl: string
  readonly capability: string
  close(): Promise<void>
}

export async function startCodingBroker(
  options: {
    provider?: CodingAgentProvider
    engine?: 'claude' | 'codex' | 'omo'
    auth: CodingAgentAuthResolver
    allowedModels: readonly string[]
    deadline: number
    signal?: AbortSignal
  },
  // Dependency injection for wire-level tests only. No config/tool operand can select a destination.
  testDependencies?: { upstream: URL },
): Promise<CodingBroker> {
  const provider = options.provider ?? 'anthropic'
  const omo = options.engine === 'omo'
  const oauthShape =
    omo &&
    provider === 'anthropic' &&
    (await options.auth.resolve(options.signal, undefined, provider)).type === 'oauth'
  // Senpi 2026.10.10 selects OAuth body/tool shaping by this prefix. It is
  // still a fresh local capability, never an upstream OAuth credential.
  const capability = `${oauthShape ? 'sk-ant-oat01-' : ''}${randomBytes(32).toString('hex')}`
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
  const upstream =
    testDependencies?.upstream ??
    new URL(provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://chatgpt.com')
  let active = 0
  let closed = false
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) reject(res, 502, 'upstream_unavailable')
      else res.destroy()
    })
  })
  server.maxHeadersCount = 64
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'))
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'))
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Coding broker could not bind loopback.')
  const baseUrl = `http://127.0.0.1:${address.port}`
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    controller.abort()
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    return closing
  }
  const onAbort = () => {
    void close()
  }
  const timer = setTimeout(onAbort, Math.max(1, options.deadline - Date.now()))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) await close()
  return { baseUrl, capability, close }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closed || signal.aborted || Date.now() >= options.deadline) return reject(res, 401, 'capability_expired')
    const provided = req.headers.authorization
    const expected = `Bearer ${capability}`
    if (
      typeof provided !== 'string' ||
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    )
      return reject(res, 401, 'invalid_capability')
    // Inspect the raw origin-form target; WHATWG URL would normalize traversal away.
    const target = req.url ?? ''
    const [route, query, extra] = target.split('?')
    if (
      req.method !== 'POST' ||
      !route ||
      !(provider === 'anthropic'
        ? ANTHROPIC_ROUTES.has(route)
        : route === (omo ? '/v1/codex/responses' : '/v1/responses')) ||
      extra !== undefined ||
      (query !== undefined && (provider !== 'anthropic' || query !== 'beta=true')) ||
      req.rawHeaders.length > 128
    ) {
      return reject(res, 400, 'unsupported_request')
    }
    if (
      req.headers.upgrade ||
      (req.headers['content-encoding'] !== undefined &&
        !(omo && provider === 'openai-codex' && req.headers['content-encoding'] === 'zstd')) ||
      REJECTED_HEADERS.some((name) => req.headers[name] !== undefined) ||
      req.headers.host !== new URL(baseUrl).host ||
      !req.headers['content-type']?.startsWith('application/json')
    )
      return reject(res, 400, 'unsupported_headers')
    if (active >= MAX_STREAMS) return reject(res, 429, 'concurrency_limit')
    active++
    const disconnected = new AbortController()
    const requestSignal = AbortSignal.any([signal, disconnected.signal])
    res.on('close', () => disconnected.abort())
    try {
      const read = await readCodingBody(req, requestSignal)
      if ('code' in read) return reject(res, read.status, read.code)
      const body = read.body
      let value: unknown
      try {
        value = JSON.parse(body.toString('utf8'))
      } catch {
        return reject(res, 400, 'invalid_json')
      }
      if (!isObject(value) || typeof value.model !== 'string' || !options.allowedModels.includes(value.model)) {
        return reject(res, 400, 'unsupported_model')
      }
      if (['url', 'base_url', 'baseURL', 'endpoint', 'upstream', 'destination'].some((key) => key in value)) {
        return reject(res, 400, 'unsupported_destination')
      }
      let auth = await options.auth.resolve(requestSignal, undefined, provider)
      const secrets = new Set(auth.secrets)
      let response = await forward(auth)
      if (response.statusCode === 401) {
        response.destroy()
        auth = await options.auth.resolve(requestSignal, auth, provider)
        auth.secrets.forEach((secret) => secrets.add(secret))
        response = await forward(auth)
      }
      const status = response.statusCode ?? 502
      const allSecrets = [...secrets, capability]
      const scrub = (text: string) => new SecretScrubber(allSecrets).push(text, true)
      for (const [key, value] of Object.entries(response.headers)) {
        if (typeof value !== 'string') continue
        // Provider-prefixed rate-limit names are untrusted text too.
        if (allSecrets.some((secret) => secret.length > 0 && key.includes(secret.toLowerCase()))) continue
        if (key === 'request-id' || key === 'x-request-id') res.setHeader(key, scrub(value).slice(0, 200))
        if (
          (key === 'retry-after' || key.startsWith('anthropic-ratelimit-') || key.startsWith('x-ratelimit-')) &&
          /^[0-9T:Z.+-]{1,64}$/.test(value)
        ) {
          res.setHeader(key, scrub(value))
        }
      }
      if (status >= 300) {
        response.destroy()
        return reject(
          res,
          status === 429 ? 429 : status === 401 || status === 403 ? 401 : 502,
          status === 429
            ? 'rate_limit'
            : status === 401 || status === 403
              ? 'authentication_required'
              : 'upstream_unavailable',
        )
      }
      const contentType = response.headers['content-type'] ?? ''
      if (!/^(application\/json|text\/event-stream)(;|$)/i.test(contentType)) {
        response.destroy()
        return reject(res, 502, 'unsupported_response')
      }
      res.statusCode = status
      res.setHeader('content-type', contentType.split(';')[0] ?? 'application/json')
      const scrubber = new SecretScrubber(allSecrets)
      const decoder = new TextDecoder()
      for await (const chunk of response) {
        requestSignal.throwIfAborted()
        const text = scrubber.push(decoder.decode(chunk, { stream: true }))
        if (text && !res.write(text)) await once(res, 'drain', { signal: requestSignal })
      }
      res.end(scrubber.push(decoder.decode(), true))

      function forward(credential: CodingAgentAuth): Promise<IncomingMessage> {
        if ((credential.provider ?? 'anthropic') !== provider)
          throw new Error('Inference credential provider mismatch.')
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          ...(provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : { accept: 'text/event-stream' }),
        }
        for (const key of provider === 'anthropic' ? ANTHROPIC_HEADERS : omo ? OMO_CODEX_HEADERS : CODEX_HEADERS) {
          const value = req.headers[key]
          if (typeof value === 'string') headers[key] = value
        }
        if (credential.provider === 'openai-codex') {
          headers.authorization = `Bearer ${credential.token}`
          headers['ChatGPT-Account-Id'] = credential.accountId
        } else if (credential.type === 'oauth') {
          headers.authorization = `Bearer ${credential.token}`
          headers['anthropic-beta'] = [
            ...new Set([
              ...(headers['anthropic-beta'] ?? '').split(',').filter(Boolean),
              'claude-code-20250219',
              'oauth-2025-04-20',
            ]),
          ].join(',')
          headers['x-app'] = 'cli'
        } else headers['x-api-key'] = credential.token
        // node:https does not honor ambient HTTP_PROXY/CA/URL overrides. Never follow Location.
        return new Promise((resolve, rejectRequest) => {
          const request = (upstream.protocol === 'https:' ? httpsRequest : httpRequest)(
            new URL(provider === 'anthropic' ? target : '/backend-api/codex/responses', upstream),
            { method: 'POST', headers, signal: requestSignal, rejectUnauthorized: true },
            resolve,
          )
          request.on('error', () => rejectRequest(new Error('Inference transport failed.')))
          // Forward the inspected JSON, never compressed bytes or an encoding
          // header from the untrusted client.
          request.end(JSON.stringify(value))
        })
      }
    } finally {
      active--
    }
  }
}

function reject(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
  res.end(JSON.stringify({ type: 'error', error: { type: code, message: code } }))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
