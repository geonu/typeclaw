import { describe, expect, test } from 'bun:test'

import { noopPermissionService } from '@/permissions'
import type { PluginContext, PluginExports, ToolAfterEvent } from '@/plugin'

import toolResultCapPlugin, { resolveCapOptionsFromConfig } from './index'

function makeCtx(overrides: { config: unknown }): {
  ctx: PluginContext<any>
  logs: string[]
} {
  const logs: string[] = []
  const ctx: PluginContext<any> = {
    name: 'tool-result-cap',
    version: undefined,
    agentDir: '/agent',
    config: overrides.config,
    logger: {
      info: (m) => logs.push(`info:${m}`),
      warn: (m) => logs.push(`warn:${m}`),
      error: (m) => logs.push(`error:${m}`),
    },
    permissions: noopPermissionService,
    github: {
      resolveTokenForRepo: async () => ({ kind: 'unavailable', reason: 'test' }),
      hasAppTokenResolver: () => false,
    },
    spawnSubagent: async () => {},
  }
  return { ctx, logs }
}

async function loadPlugin(ctx: PluginContext<any>): Promise<PluginExports> {
  return toolResultCapPlugin.plugin(ctx)
}

function hookCtx(pluginName = 'tool-result-cap') {
  return {
    agentDir: '/agent',
    pluginName,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
}

function defaultEvent(overrides: Partial<ToolAfterEvent>): ToolAfterEvent {
  return {
    tool: 'read',
    sessionId: 'sess-1',
    callId: 'call-1',
    result: { content: [{ type: 'text', text: 'ok' }] },
    ...overrides,
  }
}

describe('tool-result-cap plugin', () => {
  test('rejects imageMaxBytes below 1024', () => {
    expect(() => toolResultCapPlugin.configSchema?.parse({ imageMaxBytes: 100 })).toThrow()
  })

  test('rejects textMaxBytes below 1024', () => {
    expect(() => toolResultCapPlugin.configSchema?.parse({ textMaxBytes: 100 })).toThrow()
  })

  test('returns empty exports when disabled', async () => {
    const config = toolResultCapPlugin.configSchema?.parse({ enabled: false })
    const { ctx } = makeCtx({ config })
    const exports = await loadPlugin(ctx)
    expect(exports).toEqual({})
  })

  test('mutates oversized image results in-place', async () => {
    const config = toolResultCapPlugin.configSchema?.parse({ imageMaxBytes: 1024, textMaxBytes: 1024 })
    const { ctx } = makeCtx({ config })
    const exports = await loadPlugin(ctx)
    const hook = exports.hooks?.['tool.after']
    if (!hook) throw new Error('tool.after hook missing')

    const event = defaultEvent({
      result: { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }] },
    })

    await hook(event, hookCtx())

    expect(event.result.content[0]?.type).toBe('text')
    expect((event.result.content[0] as { text: string }).text).toContain('tool-result-cap')
  })

  test('logs a summary line on every capped tool call', async () => {
    const config = toolResultCapPlugin.configSchema?.parse({ imageMaxBytes: 1024, textMaxBytes: 1024 })
    const { ctx, logs } = makeCtx({ config })
    const exports = await loadPlugin(ctx)
    const hook = exports.hooks?.['tool.after']
    if (!hook) throw new Error('tool.after hook missing')

    await hook(
      defaultEvent({
        result: { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }] },
      }),
      hookCtx(),
    )

    const info = logs.find((l) => l.startsWith('info:[tool-result-cap]'))
    expect(info).toContain('imagesReplaced=1')
    expect(info).toContain('bytesElided=5000')
  })

  test('stays silent when nothing exceeds the thresholds', async () => {
    const config = toolResultCapPlugin.configSchema?.parse(undefined)
    const { ctx, logs } = makeCtx({ config })
    const exports = await loadPlugin(ctx)
    const hook = exports.hooks?.['tool.after']
    if (!hook) throw new Error('tool.after hook missing')

    await hook(defaultEvent({ result: { content: [{ type: 'text', text: 'short' }] } }), hookCtx())

    expect(logs).toEqual([])
  })

  test('skips tools listed in exemptTools', async () => {
    const config = toolResultCapPlugin.configSchema?.parse({
      imageMaxBytes: 1024,
      textMaxBytes: 1024,
      exemptTools: ['read'],
    })
    const { ctx, logs } = makeCtx({ config })
    const exports = await loadPlugin(ctx)
    const hook = exports.hooks?.['tool.after']
    if (!hook) throw new Error('tool.after hook missing')

    const event = defaultEvent({
      tool: 'read',
      result: { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) }] },
    })

    await hook(event, hookCtx())

    expect(event.result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(5000) })
    expect(logs).toEqual([])
  })
})

describe('resolveCapOptionsFromConfig', () => {
  test('returns null when enabled is false (load-time cap disabled)', () => {
    expect(resolveCapOptionsFromConfig({ enabled: false })).toBeNull()
  })

  test('honors user overrides and materializes exemptTools as a Set', () => {
    const opts = resolveCapOptionsFromConfig({ imageMaxBytes: 32_768, textMaxBytes: 8_192, exemptTools: ['read'] })
    expect(opts).not.toBeNull()
    expect(opts!.imageMaxBytes).toBe(32_768)
    expect(opts!.textMaxBytes).toBe(8_192)
    expect(opts!.exemptTools?.has('read')).toBe(true)
  })
})
