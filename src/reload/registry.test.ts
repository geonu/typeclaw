import { describe, expect, test } from 'bun:test'

import { ReloadRegistry } from './registry'
import type { Reloadable, ReloadResult } from './types'

const okReloadable = (scope: string, summary = `${scope} ok`): Reloadable => ({
  scope,
  description: `${scope} description`,
  reload: async () => ({ scope, ok: true, summary }),
})

const failingReloadable = (scope: string, reason: string): Reloadable => ({
  scope,
  description: `${scope} description`,
  reload: async () => ({ scope, ok: false, reason }),
})

const throwingReloadable = (scope: string, error: unknown): Reloadable => ({
  scope,
  description: `${scope} description`,
  reload: async () => {
    throw error
  },
})

describe('ReloadRegistry.register', () => {
  test('stores reloadables and exposes them via list()', () => {
    const reg = new ReloadRegistry()
    reg.register(okReloadable('cron'))
    reg.register(okReloadable('config'))

    const items = reg.list()
    expect(items.map((i) => i.scope)).toEqual(['cron', 'config'])
  })

  test('rejects duplicate scope registration', () => {
    const reg = new ReloadRegistry()
    reg.register(okReloadable('cron'))

    expect(() => reg.register(okReloadable('cron'))).toThrow(/already registered/)
  })
})

describe('ReloadRegistry.has / get', () => {
  test('has() returns true after registration', () => {
    const reg = new ReloadRegistry()
    expect(reg.has('cron')).toBe(false)
    reg.register(okReloadable('cron'))
    expect(reg.has('cron')).toBe(true)
  })

  test('get() returns the reloadable or undefined', () => {
    const reg = new ReloadRegistry()
    const item = okReloadable('cron')
    reg.register(item)
    expect(reg.get('cron')).toBe(item)
    expect(reg.get('nonexistent')).toBeUndefined()
  })
})

describe('ReloadRegistry.reloadAll', () => {
  test('returns empty results when no reloadables are registered', async () => {
    const reg = new ReloadRegistry()
    const result = await reg.reloadAll()
    expect(result.results).toEqual([])
  })

  test('returns one result per registered reloadable', async () => {
    const reg = new ReloadRegistry()
    reg.register(okReloadable('cron', 'cron summary'))
    reg.register(okReloadable('config', 'config summary'))

    const result = await reg.reloadAll()

    expect(result.results).toEqual([
      { scope: 'cron', ok: true, summary: 'cron summary' },
      { scope: 'config', ok: true, summary: 'config summary' },
    ])
  })

  test('runs reloadables serially in registration order', async () => {
    const reg = new ReloadRegistry()
    const order: string[] = []
    reg.register({
      scope: 'slow',
      description: '',
      reload: async () => {
        await new Promise((r) => setTimeout(r, 30))
        order.push('slow')
        return { scope: 'slow', ok: true, summary: '' }
      },
    })
    reg.register({
      scope: 'fast',
      description: '',
      reload: async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('fast')
        return { scope: 'fast', ok: true, summary: '' }
      },
    })

    await reg.reloadAll()

    expect(order).toEqual(['slow', 'fast'])
  })

  test('a later reloadable observes the side effects of an earlier one', async () => {
    const reg = new ReloadRegistry()
    let shared = 0
    reg.register({
      scope: 'first',
      description: '',
      reload: async () => {
        shared = 42
        return { scope: 'first', ok: true, summary: '' }
      },
    })
    const observed: number[] = []
    reg.register({
      scope: 'second',
      description: '',
      reload: async () => {
        observed.push(shared)
        return { scope: 'second', ok: true, summary: '' }
      },
    })

    await reg.reloadAll()

    expect(observed).toEqual([42])
  })

  test('one failing reloadable does not prevent others from running', async () => {
    const reg = new ReloadRegistry()
    reg.register(failingReloadable('cron', 'bad cron'))
    reg.register(okReloadable('config'))

    const result = await reg.reloadAll()

    const cron = result.results.find((r) => r.scope === 'cron') as Extract<ReloadResult, { ok: false }>
    const config = result.results.find((r) => r.scope === 'config') as Extract<ReloadResult, { ok: true }>
    expect(cron.ok).toBe(false)
    expect(cron.reason).toBe('bad cron')
    expect(config.ok).toBe(true)
  })

  test('a thrown exception from a reloadable becomes a structured failure', async () => {
    const reg = new ReloadRegistry()
    reg.register(throwingReloadable('boom', new Error('kaboom')))
    reg.register(okReloadable('survivor'))

    const result = await reg.reloadAll()

    const boom = result.results.find((r) => r.scope === 'boom') as Extract<ReloadResult, { ok: false }>
    expect(boom.ok).toBe(false)
    expect(boom.reason).toMatch(/kaboom/)

    const survivor = result.results.find((r) => r.scope === 'survivor')
    expect(survivor?.ok).toBe(true)
  })

  test('non-Error throws are coerced to a string reason', async () => {
    const reg = new ReloadRegistry()
    reg.register(throwingReloadable('odd', { weird: 'object' }))

    const result = await reg.reloadAll()

    const odd = result.results[0] as Extract<ReloadResult, { ok: false }>
    expect(odd.ok).toBe(false)
    expect(odd.reason).toBeTruthy()
  })
})

describe('ReloadRegistry.reloadOne', () => {
  test('reloads a single registered scope', async () => {
    const reg = new ReloadRegistry()
    reg.register(okReloadable('cron', 'just cron'))
    reg.register(okReloadable('config'))

    const result = await reg.reloadOne('cron')

    expect(result.scope).toBe('cron')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.summary).toBe('just cron')
  })

  test('returns a structured failure for unknown scope', async () => {
    const reg = new ReloadRegistry()
    reg.register(okReloadable('cron'))

    const result = await reg.reloadOne('nonexistent')

    expect(result.scope).toBe('nonexistent')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/unknown scope/i)
  })

  test('coerces a thrown exception into a structured failure', async () => {
    const reg = new ReloadRegistry()
    reg.register(throwingReloadable('boom', new Error('kaboom')))

    const result = await reg.reloadOne('boom')

    expect(result.scope).toBe('boom')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/kaboom/)
  })
})
