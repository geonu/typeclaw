import { timingSafeEqual } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'

// The managed Chrome runs in a network-isolated sandbox, so its DevTools port
// is unreachable from model bash. This relay is the only path in: a loopback
// TCP listener that admits a connection only when its first HTTP request
// carries the session token, then forwards it to Chrome's DevTools socket.
// The token reaches bash only for roles holding `browser.shared`, so a
// lower-privilege session cannot drive pages another role is logged into.

const MAX_HEAD_BYTES = 64 * 1024
const BROWSER_PATH = /^\/devtools\/browser\/[^/?#]*/

export type CdpRelayOptions = {
  token: string
  // Unix socket bridged to Chrome's private DevTools port.
  upstreamSocket: string
  host?: string
  port?: number
}

export type CdpRelay = {
  port: number
  close: () => Promise<void>
}

export async function startCdpRelay(options: CdpRelayOptions): Promise<CdpRelay> {
  const host = options.host ?? '127.0.0.1'
  const server = createServer((client) => handleClient(client, options, host, server))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('CDP relay did not bind a TCP port')
  return { port: address.port, close: () => closeServer(server) }
}

export function cdpWebSocketUrl(port: number, token: string): string {
  return `ws://127.0.0.1:${port}/devtools/browser/typeclaw?token=${encodeURIComponent(token)}`
}

function handleClient(client: Socket, options: CdpRelayOptions, host: string, server: Server): void {
  let buffered = Buffer.alloc(0)
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk])
    const headEnd = buffered.indexOf('\r\n\r\n')
    if (headEnd === -1) {
      if (buffered.length > MAX_HEAD_BYTES) client.destroy()
      return
    }
    client.off('data', onData)
    client.pause()
    const head = buffered.subarray(0, headEnd).toString('latin1')
    const rest = buffered.subarray(headEnd + 4)
    const request = parseHead(head)
    if (request === null || !tokenMatches(request.token, options.token)) {
      client.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      return
    }
    const relayPort = (server.address() as { port: number }).port
    if (request.isUpgrade) {
      pipeUpgrade(client, options.upstreamSocket, request, rest)
    } else {
      void answerDiscovery(client, options, request.path, `${host}:${relayPort}`)
    }
  }
  client.on('data', onData)
  client.on('error', () => client.destroy())
}

type ParsedHead = {
  method: string
  path: string
  token: string | undefined
  isUpgrade: boolean
  headerLines: string[]
}

function parseHead(head: string): ParsedHead | null {
  const [requestLine, ...headerLines] = head.split('\r\n')
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine ?? '')
  if (match === null) return null
  let url: URL
  try {
    url = new URL(match[2]!, 'http://relay.invalid')
  } catch {
    return null
  }
  const queryToken = url.searchParams.get('token') ?? undefined
  url.searchParams.delete('token')
  const authorization = headerLines
    .find((line) => line.toLowerCase().startsWith('authorization:'))
    ?.slice('authorization:'.length)
    .trim()
  const headerToken = authorization?.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : undefined
  const isUpgrade = headerLines.some((line) => /^upgrade:\s*websocket\s*$/i.test(line))
  return {
    method: match[1]!,
    path: `${url.pathname}${url.search}`,
    token: queryToken ?? headerToken,
    isUpgrade,
    headerLines: headerLines.filter((line) => !line.toLowerCase().startsWith('authorization:')),
  }
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Chrome's browser target id changes on every launch, so clients connect to a
// stable `/devtools/browser/<anything>` path and the relay substitutes the
// live id discovered from Chrome itself.
function pipeUpgrade(client: Socket, upstreamSocket: string, request: ParsedHead, rest: Buffer): void {
  void resolveBrowserPath(upstreamSocket, request.path).then(
    (path) => {
      const upstream = connect(upstreamSocket)
      upstream.on('connect', () => {
        upstream.write(`${request.method} ${path} HTTP/1.1\r\n${request.headerLines.join('\r\n')}\r\n\r\n`)
        if (rest.length > 0) upstream.write(rest)
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    },
    () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'),
  )
}

async function resolveBrowserPath(upstreamSocket: string, path: string): Promise<string> {
  if (!BROWSER_PATH.test(path)) return path
  const version = (await fetchUpstreamJson(upstreamSocket, '/json/version')) as { webSocketDebuggerUrl?: string }
  const live = version.webSocketDebuggerUrl === undefined ? undefined : new URL(version.webSocketDebuggerUrl).pathname
  if (live === undefined) throw new Error('Chrome did not report a browser target')
  return path.replace(BROWSER_PATH, live)
}

// `/json/*` answers embed Chrome's private `127.0.0.1:9222`; rewrite them to
// the relay (with the token) so a client that discovers over HTTP reconnects
// through the relay instead of to an address it cannot reach.
async function answerDiscovery(client: Socket, options: CdpRelayOptions, path: string, relayHost: string) {
  try {
    const body = await fetchUpstreamText(options.upstreamSocket, path)
    const rewritten = body.replace(
      /ws:\/\/[^/"]+(\/devtools\/[^"]+)/g,
      (_all, devtoolsPath: string) => `ws://${relayHost}${devtoolsPath}?token=${encodeURIComponent(options.token)}`,
    )
    const bytes = Buffer.from(rewritten)
    client.write(
      `HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=UTF-8\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`,
    )
    client.end(bytes)
  } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  }
}

async function fetchUpstreamJson(upstreamSocket: string, path: string): Promise<unknown> {
  return JSON.parse(await fetchUpstreamText(upstreamSocket, path)) as unknown
}

async function fetchUpstreamText(upstreamSocket: string, path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1${path}`, { unix: upstreamSocket } as RequestInit)
  if (!response.ok) throw new Error(`DevTools answered ${response.status} for ${path}`)
  return response.text()
}

// Token-gated raw byte relay for the BrowserSkill daemon socket: the client
// sends the token and a newline, then speaks the daemon's own protocol. A
// `<token> describe` line instead returns `describe()` (the daemon's
// daemon.json, which the CLI cross-checks against the IPC daemon's pid).
export async function startTokenStreamRelay(options: {
  token: string
  upstreamSocket: string
  describe?: () => Promise<string>
}): Promise<CdpRelay> {
  const server = createServer((client) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      const newline = buffered.indexOf('\n')
      if (newline === -1) {
        if (buffered.length > 1024) client.destroy()
        return
      }
      client.off('data', onData)
      client.pause()
      const [candidate, verb] = buffered.subarray(0, newline).toString('latin1').split(' ')
      if (!tokenMatches(candidate, options.token)) {
        client.destroy()
        return
      }
      if (verb === 'describe' && options.describe !== undefined) {
        options.describe().then(
          (text) => client.end(text),
          () => client.destroy(),
        )
        return
      }
      const upstream = connect(options.upstreamSocket)
      upstream.on('connect', () => {
        const rest = buffered.subarray(newline + 1)
        if (rest.length > 0) upstream.write(rest)
        client.pipe(upstream)
        upstream.pipe(client)
        client.resume()
      })
      upstream.on('error', () => client.destroy())
      upstream.on('close', () => client.destroy())
      client.on('close', () => upstream.destroy())
    }
    client.on('data', onData)
    client.on('error', () => client.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as { port: number }
  return { port: address.port, close: () => closeServer(server) }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
