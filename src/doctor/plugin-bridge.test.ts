import { describe, expect, test } from 'bun:test'

import { CONTAINER_PORT } from '@/container'

import { fetchPluginDoctorChecks, resolveInContainerBridgeUrl } from './plugin-bridge'

describe('plugin doctor bridge', () => {
  test('redacts tokenized URLs in connection errors', async () => {
    const result = await fetchPluginDoctorChecks({
      cwd: process.cwd(),
      url: 'ws://localhost:1?token=secret-token',
      timeoutMs: 200,
    })

    expect(result.kind).toBe('unreachable')
    if (result.kind !== 'unreachable') throw new Error('expected unreachable result')
    expect(result.reason).toContain('token=%3Credacted%3E')
    expect(result.reason).not.toContain('secret-token')
  })

  test('dials the container loopback with the TUI token when present', () => {
    expect(resolveInContainerBridgeUrl({ TYPECLAW_TUI_TOKEN: 'tok' })).toBe(
      `ws://127.0.0.1:${CONTAINER_PORT}/?token=tok`,
    )
    expect(resolveInContainerBridgeUrl({})).toBe(`ws://127.0.0.1:${CONTAINER_PORT}/`)
    expect(resolveInContainerBridgeUrl({ TYPECLAW_TUI_TOKEN: '' })).toBe(`ws://127.0.0.1:${CONTAINER_PORT}/`)
  })
})
