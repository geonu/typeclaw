import { describe, expect, it, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'
import { createStream } from '@/stream'
import { waitFor } from '@/test-helpers/wait-for'

import { createTunnelManager } from './manager'
import type { TunnelConfig, TunnelUrlChangedPayload } from './types'

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }
const onWindows = isWindows()

function createScratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'tunnel-manager-test-'))
}

function installFakeCloudflared(scratchDir: string, script: string): string {
  const binDir = join(scratchDir, 'bin')
  const path = join(binDir, 'cloudflared')
  mkdirSync(binDir)
  writeFileSync(path, `#!/bin/sh\n${script}\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function externalConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    name: 'demo',
    provider: 'external',
    for: { kind: 'manual' },
    externalUrl: 'https://demo.example.com',
    ...overrides,
  }
}

function cloudflareQuickConfig(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
  return {
    name: 'github-webhook',
    provider: 'cloudflare-quick',
    for: { kind: 'channel', name: 'github' },
    ...overrides,
  }
}

describe('createTunnelManager (external provider)', () => {
  it('publishes a tunnel-url-changed broadcast on start', async () => {
    // given
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    // when
    await manager.start()

    // then
    expect(received).toHaveLength(1)
    expect(received[0]?.kind).toBe('tunnel-url-changed')
    expect(received[0]?.tunnelName).toBe('demo')
    expect(received[0]?.url).toBe('https://demo.example.com')
    expect(received[0]?.for).toEqual({ kind: 'manual' })
  })

  it('snapshot reports healthy after start, stopped after stop', async () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(manager.snapshot()[0]?.status).toBe('stopped')
    await manager.start()
    expect(manager.snapshot()[0]?.status).toBe('healthy')
    expect(manager.snapshot()[0]?.url).toBe('https://demo.example.com')
    await manager.stop()
    expect(manager.snapshot()[0]?.status).toBe('stopped')
  })

  it('urlFor returns the configured URL after start, null before', async () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(manager.urlFor('demo')).toBeNull()
    await manager.start()
    expect(manager.urlFor('demo')).toBe('https://demo.example.com')
    expect(manager.urlFor('unknown')).toBeNull()
  })

  it('routes the for tag through to the broadcast payload (channel kind)', async () => {
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({
      tunnels: [externalConfig({ name: 'gh', for: { kind: 'channel', name: 'github' } })],
      stream,
      logger: silentLogger,
    })

    await manager.start()

    expect(received[0]?.for).toEqual({ kind: 'channel', name: 'github' })
    expect(received[0]?.tunnelName).toBe('gh')
  })

  it('publishes one broadcast per tunnel when multiple are configured', async () => {
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({
      tunnels: [
        externalConfig({ name: 'a', externalUrl: 'https://a.example.com' }),
        externalConfig({ name: 'b', externalUrl: 'https://b.example.com' }),
      ],
      stream,
      logger: silentLogger,
    })

    await manager.start()

    expect(received).toHaveLength(2)
    expect(received.map((p) => p.tunnelName).sort()).toEqual(['a', 'b'])
  })

  it('rejects external tunnels missing externalUrl at provider construction', () => {
    const stream = createStream()
    expect(() =>
      createTunnelManager({
        tunnels: [externalConfig({ externalUrl: undefined })],
        stream,
        logger: silentLogger,
      }),
    ).toThrow(/externalUrl is required/)
  })

  it('start is idempotent: second start does not republish', async () => {
    const stream = createStream()
    const received: TunnelUrlChangedPayload[] = []
    stream.subscribe({ target: { kind: 'broadcast' } }, (msg) => {
      received.push(msg.payload as TunnelUrlChangedPayload)
    })
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    await manager.start()
    await manager.start()

    expect(received).toHaveLength(1)
  })

  it('tail returns an empty log snapshot for external tunnels and unknown names', () => {
    const stream = createStream()
    const manager = createTunnelManager({ tunnels: [externalConfig()], stream, logger: silentLogger })

    expect(manager.tail('demo')).toEqual([])
    expect(manager.tail('unknown')).toEqual([])
  })

  it('does not call the channel upstream resolver for external tunnels', async () => {
    const stream = createStream()
    let calls = 0
    const manager = createTunnelManager({
      tunnels: [externalConfig({ for: { kind: 'channel', name: 'github' } })],
      stream,
      logger: silentLogger,
      resolveChannelUpstreamPort: () => {
        calls += 1
        return 8975
      },
    })

    await manager.start()

    expect(calls).toBe(0)
  })
})

describe('createTunnelManager (cloudflare-quick provider)', () => {
  // Spawns cloudflared; absent on the Windows runner. #899
  test.skipIf(onWindows)('resolves channel-owned upstream ports before constructing the provider', async () => {
    const scratchDir = createScratchDir()
    const argvFile = join(scratchDir, 'argv.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
printf '%s\n' "$@" > "${argvFile}"
`,
    )
    try {
      const manager = createTunnelManager({
        tunnels: [cloudflareQuickConfig()],
        stream: createStream(),
        logger: silentLogger,
        cloudflareQuickBinary: binary,
        resolveChannelUpstreamPort: (channelName) => (channelName === 'github' ? 8975 : null),
      })

      await manager.start()
      await waitFor(() => existsSync(argvFile) && readFileSync(argvFile, 'utf8').includes('http://127.0.0.1:8975'), {
        description: 'cloudflared argv',
      })

      expect((await readFile(argvFile, 'utf8')).split('\n').filter(Boolean)).toContain('http://127.0.0.1:8975')
      await manager.stop()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })

  it('rejects channel-owned quick tunnels when no upstream port resolves', () => {
    expect(() =>
      createTunnelManager({
        tunnels: [cloudflareQuickConfig()],
        stream: createStream(),
        logger: silentLogger,
        resolveChannelUpstreamPort: () => null,
      }),
    ).toThrow("tunnel 'github-webhook' (cloudflare-quick): no upstream port resolved for channel 'github'")
  })

  // Spawns cloudflared; absent on the Windows runner. #899
  test.skipIf(onWindows)('uses manual upstreamPort without calling the channel resolver', async () => {
    const scratchDir = createScratchDir()
    const argvFile = join(scratchDir, 'argv.txt')
    const binary = installFakeCloudflared(
      scratchDir,
      `
printf '%s\n' "$@" > "${argvFile}"
`,
    )
    let calls = 0

    try {
      const manager = createTunnelManager({
        tunnels: [cloudflareQuickConfig({ for: { kind: 'manual' }, upstreamPort: 5173 })],
        stream: createStream(),
        logger: silentLogger,
        cloudflareQuickBinary: binary,
        resolveChannelUpstreamPort: () => {
          calls += 1
          return 8975
        },
      })

      await manager.start()
      await waitFor(() => existsSync(argvFile) && readFileSync(argvFile, 'utf8').includes('http://127.0.0.1:5173'), {
        description: 'manual cloudflared argv',
      })

      expect(calls).toBe(0)
      expect((await readFile(argvFile, 'utf8')).split('\n').filter(Boolean)).toContain('http://127.0.0.1:5173')
      await manager.stop()
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
