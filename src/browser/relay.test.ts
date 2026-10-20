import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cdpWebSocketUrl, type CdpRelay, startCdpRelay, startTokenStreamRelay } from './relay'

const TOKEN = 'a'.repeat(64)
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

// Stands in for Chrome's DevTools endpoint behind the sandbox socket: answers
// discovery with its private address and echoes browser-target WebSocket frames.
async function startFakeDevtools(): Promise<string> {
  const socket = join(tmpdir(), `typeclaw-relay-${randomUUID()}.sock`)
  const server = Bun.serve({
    unix: socket,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === '/json/version') {
        return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/live-id' })
      }
      if (url.pathname === '/devtools/browser/live-id' && srv.upgrade(request, { data: undefined })) return undefined
      return new Response('not found', { status: 404 })
    },
    websocket: {
      message: (ws, message) => {
        ws.send(`echo:${String(message)}`)
      },
    },
  })
  cleanups.push(async () => {
    await server.stop(true)
    await rm(socket, { force: true })
  })
  return socket
}

async function startRelay(): Promise<CdpRelay> {
  const relay = await startCdpRelay({ token: TOKEN, upstreamSocket: await startFakeDevtools() })
  cleanups.push(() => relay.close())
  return relay
}

function openSocket(url: string): Promise<{ ws: WebSocket; opened: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.onopen = () => resolve({ ws, opened: true })
    ws.onerror = () => resolve({ ws, opened: false })
  })
}

describe('CDP relay', () => {
  test('rejects discovery without the token and with a wrong one', async () => {
    const relay = await startRelay()

    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version`)).status).toBe(401)
    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version?token=${'b'.repeat(64)}`)).status).toBe(401)
  })

  test('answers authorized discovery with relay-addressed, token-carrying URLs', async () => {
    const relay = await startRelay()

    const viaQuery = await fetch(`http://127.0.0.1:${relay.port}/json/version?token=${TOKEN}`)
    const viaHeader = await fetch(`http://127.0.0.1:${relay.port}/json/version`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })

    const expected = `ws://127.0.0.1:${relay.port}/devtools/browser/live-id?token=${TOKEN}`
    expect(((await viaQuery.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl).toBe(expected)
    expect(((await viaHeader.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl).toBe(expected)
  })

  test('routes the stable browser URL to the live browser target', async () => {
    const relay = await startRelay()
    const { ws, opened } = await openSocket(cdpWebSocketUrl(relay.port, TOKEN))
    expect(opened).toBe(true)

    const reply = new Promise<string>((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data))
    })
    ws.send('ping')

    expect(await reply).toBe('echo:ping')
    ws.close()
  })

  test('refuses a WebSocket upgrade without the token', async () => {
    const relay = await startRelay()

    const { opened } = await openSocket(`ws://127.0.0.1:${relay.port}/devtools/browser/typeclaw`)

    expect(opened).toBe(false)
  })
})

function rawExchange(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(payload))
    let received = ''
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString()
    })
    socket.on('close', () => resolve(received))
    socket.on('error', () => resolve(received))
  })
}

describe('CDP relay request parsing', () => {
  test('rejects an unparseable request target without a token and keeps serving', async () => {
    const relay = await startRelay()

    const reply = await rawExchange(relay.port, 'GET http://[ HTTP/1.1\r\n\r\n')

    expect(reply).toStartWith('HTTP/1.1 401')
    expect((await fetch(`http://127.0.0.1:${relay.port}/json/version?token=${TOKEN}`)).status).toBe(200)
  })
})

describe('BrowserSkill token stream relay', () => {
  async function startEchoDaemon(): Promise<string> {
    const socket = join(tmpdir(), `typeclaw-bsk-${randomUUID()}.sock`)
    const server = createServer((client) => client.on('data', (chunk) => client.write(`echo:${chunk.toString()}`)))
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(socket, { force: true })
    })
    return socket
  }

  function exchangeUntilReply(port: number, payload: string): Promise<string> {
    return new Promise((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(payload))
      socket.on('data', (chunk: Buffer) => {
        resolve(chunk.toString())
        socket.destroy()
      })
      socket.on('close', () => resolve(''))
      socket.on('error', () => resolve(''))
    })
  }

  test('forwards to the daemon socket only after the token line', async () => {
    const relay = await startTokenStreamRelay({ token: TOKEN, upstreamSocket: await startEchoDaemon() })
    cleanups.push(() => relay.close())

    expect(await exchangeUntilReply(relay.port, `${TOKEN}\nping`)).toBe('echo:ping')
    expect(await exchangeUntilReply(relay.port, `${'b'.repeat(64)}\nping`)).toBe('')
    expect(await exchangeUntilReply(relay.port, 'ping\n')).toBe('')
  })
})
