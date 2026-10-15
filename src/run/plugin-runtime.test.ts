import { describe, expect, test } from 'bun:test'

import type { HookBus, PluginRegistry } from '@/plugin'
import { createHookBus } from '@/plugin'
import { emptyRegistry } from '@/plugin/registry'

import { createPluginRuntime, type PluginRuntimeState } from './plugin-runtime'

function makeState(overrides: Partial<PluginRuntimeState> = {}): PluginRuntimeState {
  const registry: PluginRegistry = overrides.registry ?? emptyRegistry()
  const hooks: HookBus = overrides.hooks ?? createHookBus()
  return {
    registry,
    hooks,
    subagents: overrides.subagents ?? {},
    pluginSubagentByShim: overrides.pluginSubagentByShim ?? new WeakMap(),
    hasAnyPluginContent: overrides.hasAnyPluginContent ?? false,
    loadedPlugins: overrides.loadedPlugins ?? [],
    materializedSkills: overrides.materializedSkills ?? null,
  }
}

describe('createPluginRuntime', () => {
  test('get() returns the initial state', () => {
    // given
    const initial = makeState({ hasAnyPluginContent: true })

    // when
    const runtime = createPluginRuntime(initial)

    // then
    expect(runtime.get()).toBe(initial)
  })

  test('swap(next) replaces the current state', () => {
    // given
    const initial = makeState()
    const next = makeState({ hasAnyPluginContent: true })
    const runtime = createPluginRuntime(initial)

    // when
    runtime.swap(next)

    // then
    expect(runtime.get()).toBe(next)
  })

  test('swap(next) returns the previous state', () => {
    // given
    const initial = makeState()
    const next = makeState({ hasAnyPluginContent: true })
    const runtime = createPluginRuntime(initial)

    // when
    const prev = runtime.swap(next)

    // then
    expect(prev).toBe(initial)
  })

  test('trackPendingDisposal then drainPendingDisposal returns items in order', async () => {
    // given
    const runtime = createPluginRuntime(makeState())
    const a = { dir: '/tmp/a', dispose: async () => {} }
    const b = { dir: '/tmp/b', dispose: async () => {} }

    // when
    runtime.trackPendingDisposal(a)
    runtime.trackPendingDisposal(b)
    const drained = runtime.drainPendingDisposal()

    // then
    expect(drained).toEqual([a, b])
  })

  test('drainPendingDisposal empties the list', () => {
    // given
    const runtime = createPluginRuntime(makeState())
    runtime.trackPendingDisposal({ dir: '/tmp/x', dispose: async () => {} })

    // when
    runtime.drainPendingDisposal()

    // then
    expect(runtime.drainPendingDisposal()).toEqual([])
  })
})
