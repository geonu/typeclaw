import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startSocksEgress } from './egress'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function socksRequest(socketPath: string, request: Buffer, payload: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let received = Buffer.alloc(0)
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk])
      if (received.length === 2) socket.write(Buffer.concat([request, Buffer.from(payload)]))
    })
    socket.on('close', () => resolve(received))
    socket.on('error', reject)
  })
}

test('SOCKS5 egress dials a domain target and relays both directions', async () => {
  const origin = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('from-origin') })
  cleanups.push(() => origin.stop(true))
  const socketPath = join(tmpdir(), `typeclaw-egress-${randomUUID()}.sock`)
  const egress = await startSocksEgress(socketPath)
  cleanups.push(async () => {
    await egress.close()
    await rm(socketPath, { force: true })
  })
  const host = Buffer.from('localhost')
  const port = Buffer.alloc(2)
  port.writeUInt16BE(origin.port!)

  const received = await socksRequest(
    socketPath,
    Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]),
    'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
  )

  expect(received.subarray(0, 2)).toEqual(Buffer.from([0x05, 0x00]))
  expect(received.subarray(2, 4)).toEqual(Buffer.from([0x05, 0x00]))
  expect(received.subarray(12).toString()).toContain('from-origin')
})

test('SOCKS5 egress refuses non-CONNECT commands', async () => {
  const socketPath = join(tmpdir(), `typeclaw-egress-${randomUUID()}.sock`)
  const egress = await startSocksEgress(socketPath)
  cleanups.push(async () => {
    await egress.close()
    await rm(socketPath, { force: true })
  })

  const bind = Buffer.from([0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0, 80])
  const received = await socksRequest(socketPath, bind, '')

  expect(received[3]).toBe(0x07)
})
