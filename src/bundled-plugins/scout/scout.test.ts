import { describe, expect, test } from 'bun:test'

import { SCOUT_SYSTEM_PROMPT, SCOUT_TIMEOUT_MS, createScoutSubagent, scoutPayloadSchema } from './scout'

describe('scout subagent — load-bearing prompt phrases', () => {
  test.each(
    ['<analysis>', '<results>', '<sources>', '<answer>', '<confidence>', '<next_steps>'].map(
      (phrase) => [phrase] as const,
    ),
  )('prompt contains %s', (phrase) => {
    const haystack = SCOUT_SYSTEM_PROMPT.toLowerCase().replace(/\s+/g, '_')
    expect(haystack).toContain(phrase.toLowerCase().replace(/\s+/g, '_'))
  })
})

describe('scout subagent declaration', () => {
  test('uses the fast model profile (cheap and parallelizable for read-only research)', () => {
    const sub = createScoutSubagent()
    expect(sub.profile).toBe('fast')
  })

  test('declares a timeoutMs so a wedged run cannot block its parent forever', () => {
    // startSubagent only arms its timeout guard when timeoutMs is set; a scout
    // without one deadlocks a researcher that spawned it (the incident this fixes).
    const sub = createScoutSubagent()
    expect(sub.timeoutMs).toBe(SCOUT_TIMEOUT_MS)
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('tools list is exactly [web_search, web_fetch] and NO filesystem tools', () => {
    const sub = createScoutSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['web_fetch', 'web_search'])
    // Drift guard: scout must never gain filesystem access. The whole
    // point of the explorer/scout split is that scout has no read/grep/ls
    // and explorer has no web_search/web_fetch — collapsing either side
    // makes one of the two subagents redundant and reintroduces the
    // confused-deputy risk (web pages tricking scout into reading
    // .env / secrets.json).
    expect(toolNames).not.toContain('read')
    expect(toolNames).not.toContain('grep')
    expect(toolNames).not.toContain('find')
    expect(toolNames).not.toContain('ls')
    expect(toolNames).not.toContain('bash')
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('toolRefs resolve to the web_search+web_fetch ToolDefinitions (customTools path), with no pi coding builtins leaking', async () => {
    const { resolveBuiltinToolRefs } = await import('@/agent/plugin-tools')
    const { webSearchTool } = await import('@/agent/tools/websearch')
    const { webFetchTool } = await import('@/agent/tools/webfetch')
    const sub = createScoutSubagent()
    const resolved = resolveBuiltinToolRefs(sub.tools ?? [], process.cwd())
    expect(resolved.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search'])
    const byName = Object.fromEntries(resolved.map((t) => [t.name, t]))
    expect(byName.web_search).toBe(webSearchTool)
    expect(byName.web_fetch).toBe(webFetchTool)
  })

  test('declares a tool-result budget keyed on web_search+web_fetch (so a runaway scout cannot exhaust parent context)', () => {
    const sub = createScoutSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
    expect([...(sub.toolResultBudget?.toolNames ?? [])].sort()).toEqual(['web_fetch', 'web_search'])
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createScoutSubagent()
    const key1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const key2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(key1).toBe('bg_a')
    expect(key2).toBe('bg_b')
    expect(key1).not.toBe(key2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createScoutSubagent()
    const key1 = sub.inFlightKey?.({})
    const key2 = sub.inFlightKey?.({})
    expect(key1).not.toBe(key2)
  })
})

describe('scoutPayloadSchema', () => {
  test('accepts a payload with requestId + prompt + description', () => {
    const result = scoutPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'latest stable version of Bun',
      description: 'bun version check',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = scoutPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params)', () => {
    const result = scoutPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
    expect((result.data as Record<string, unknown>).futureField).toBe(42)
  })

  test('drops a parent-supplied profile so scout cannot be bumped off its fast tier', () => {
    const result = scoutPayloadSchema.safeParse({ requestId: 'bg_t1', prompt: 'x', profile: 'deep' })
    expect(result.success).toBe(true)
    expect(result.data).not.toHaveProperty('profile')
  })
})
