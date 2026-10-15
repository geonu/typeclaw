import { describe, expect, test } from 'bun:test'

import { createExplorerSubagent, explorerPayloadSchema } from './explorer'

describe('explorer subagent declaration', () => {
  test('tools list contains read/grep/find/ls/bash and NO write/edit', () => {
    const sub = createExplorerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool)
    expect(toolNames.sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read'])
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createExplorerSubagent()
    const key1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const key2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(key1).toBe('bg_a')
    expect(key2).toBe('bg_b')
    expect(key1).not.toBe(key2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createExplorerSubagent()
    const key1 = sub.inFlightKey?.({})
    const key2 = sub.inFlightKey?.({})
    expect(key1).not.toBe(key2)
  })
})

describe('explorerPayloadSchema', () => {
  test('passes through unknown fields (forward-compat with future spawn-tool params)', () => {
    const result = explorerPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).futureField).toBe(42)
  })

  test('drops a parent-supplied profile so explorer cannot be bumped off its fast tier', () => {
    const result = explorerPayloadSchema.safeParse({ requestId: 'bg_t1', prompt: 'x', profile: 'deep' })
    expect(result.success).toBe(true)
    expect(result.data).not.toHaveProperty('profile')
  })
})
