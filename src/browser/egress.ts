import { connect, createServer, type Server, type Socket } from 'node:net'

// Minimal SOCKS5 (RFC 1928) CONNECT-only server on a Unix socket. It is the
// managed Chrome's only route out of its network-isolated sandbox. Destinations
// are dialed from the container's network namespace, so the container egress
// filter (`network.blockInternal`) applies exactly as it does to model bash,
// and a dev server bash started on container loopback stays reachable.

const VERSION = 0x05
const NO_AUTH = 0x00
const NO_ACCEPTABLE_METHOD = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04
const REPLY_OK = 0x00
const REPLY_FAILURE = 0x01
const REPLY_COMMAND_UNSUPPORTED = 0x07

export async function startSocksEgress(socketPath: string): Promise<{ close: () => Promise<void> }> {
  const server = createServer(handleClient)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return { close: () => closeServer(server) }
}

function handleClient(client: Socket): void {
  let buffered = Buffer.alloc(0)
  let stage: 'greeting' | 'request' = 'greeting'
  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk])
    if (stage === 'greeting') {
      if (buffered.length < 2 || buffered.length < 2 + buffered[1]!) return
      const methods = buffered.subarray(2, 2 + buffered[1]!)
      if (buffered[0] !== VERSION || !methods.includes(NO_AUTH)) {
        client.end(Buffer.from([VERSION, NO_ACCEPTABLE_METHOD]))
        return
      }
      buffered = buffered.subarray(2 + buffered[1]!)
      stage = 'request'
      client.write(Buffer.from([VERSION, NO_AUTH]))
    }
    const target = parseConnectRequest(buffered)
    if (target === 'incomplete') return
    client.off('data', onData)
    client.pause()
    if (target === 'unsupported') {
      client.end(reply(REPLY_COMMAND_UNSUPPORTED))
      return
    }
    const upstream = connect({ host: target.host, port: target.port })
    upstream.once('connect', () => {
      client.write(reply(REPLY_OK))
      if (target.rest.length > 0) upstream.write(target.rest)
      client.pipe(upstream)
      upstream.pipe(client)
      client.resume()
    })
    upstream.once('error', () => client.end(reply(REPLY_FAILURE)))
    upstream.on('close', () => client.destroy())
    client.on('close', () => upstream.destroy())
  }
  client.on('data', onData)
  client.on('error', () => client.destroy())
}

type ConnectTarget = { host: string; port: number; rest: Buffer }

function parseConnectRequest(buf: Buffer): ConnectTarget | 'incomplete' | 'unsupported' {
  if (buf.length < 5) return 'incomplete'
  if (buf[0] !== VERSION || buf[1] !== CMD_CONNECT) return 'unsupported'
  const atyp = buf[3]
  let host: string
  let offset: number
  if (atyp === ATYP_IPV4) {
    if (buf.length < 10) return 'incomplete'
    host = [...buf.subarray(4, 8)].join('.')
    offset = 8
  } else if (atyp === ATYP_DOMAIN) {
    const length = buf[4]!
    if (buf.length < 5 + length + 2) return 'incomplete'
    host = buf.subarray(5, 5 + length).toString('latin1')
    offset = 5 + length
  } else if (atyp === ATYP_IPV6) {
    if (buf.length < 22) return 'incomplete'
    const groups: string[] = []
    for (let i = 4; i < 20; i += 2) groups.push(buf.readUInt16BE(i).toString(16))
    host = groups.join(':')
    offset = 20
  } else {
    return 'unsupported'
  }
  return { host, port: buf.readUInt16BE(offset), rest: buf.subarray(offset + 2) }
}

function reply(code: number): Buffer {
  return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}
