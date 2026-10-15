import { describe, expect, test } from 'bun:test'

import {
  RESEARCHER_SKILLS,
  RESEARCHER_SYSTEM_PROMPT,
  createResearcherSubagent,
  researcherPayloadSchema,
} from './researcher'

describe('researcher subagent — load-bearing prompt phrases', () => {
  test.each(
    ['<analysis>', '<report>', '<summary>', '<report_file>', '<confidence>', '<open_questions>', 'load_skill'].map(
      (phrase) => [phrase] as const,
    ),
  )('prompt contains %s', (phrase) => {
    const haystack = RESEARCHER_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })
})

describe('researcher subagent declaration', () => {
  test('uses the deep model profile (quality over speed, the deep counterpart to fast scout)', () => {
    const sub = createResearcherSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    // Unlike operator, the researcher's only write is a sandboxed report file,
    // so it is NOT gated to owner/trusted. Flipping this to true would silently
    // lock member/guest out of research.
    const sub = createResearcherSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares canSpawnSubagents=true (deep researcher offloads bulk gathering to scout/explorer)', () => {
    const sub = createResearcherSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('builtin tools are READ-ONLY: no generic write or edit (the writer is the enforced write_report custom tool)', () => {
    const sub = createResearcherSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search'])
    // Security drift guard (the review finding): the generic `write` tool's
    // runtime boundary (the non-workspace-write guard) is too broad for a
    // guest-spawnable subagent — it allowlists IDENTITY.md/cron.json/etc. and
    // honors acknowledgeGuards. The researcher must NOT hold it; its only writer
    // is the dedicated, code-enforced write_report custom tool. If a future edit
    // re-adds writeTool/editTool here, the hole reopens and this fails.
    expect(toolNames).not.toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('customTools are exactly [load_skill, write_report] — the skill loader and the only file writer', () => {
    const sub = createResearcherSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools).toHaveLength(2)
    const [loadSkill, writeReport] = sub.customTools ?? []
    if (loadSkill === undefined || writeReport === undefined) throw new Error('expected load_skill + write_report')
    expect(loadSkill.description).toContain('`general`')
    expect(writeReport.description.toLowerCase()).toContain('research report')
  })

  test('load_skill parameter schema accepts the shipped skill name and rejects unknown ones', () => {
    const sub = createResearcherSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.parameters.safeParse({ name: 'general' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'market-research' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('declares a tool-result budget so a runaway research pass cannot exhaust parent context', () => {
    const sub = createResearcherSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('tool-result budget covers the builtin read/web tools and omits custom tools (which surface under __plugin_* names)', () => {
    // Custom tools (load_skill, write_report) are renamed to
    // `__plugin_researcher_researcher_<i>` at wrap time, so a name-keyed budget
    // entry for them would be dead config. The budget keys only the builtins.
    const sub = createResearcherSubagent()
    const names = sub.toolResultBudget?.toolNames ?? []
    expect([...names].sort()).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search'])
    expect(names).not.toContain('write')
    expect(names).not.toContain('load_skill')
    expect(names).not.toContain('write_report')
  })

  test('budget sits between explorer (256KB) and operator (1MB) — deep but bounded, bulk is delegated', () => {
    const sub = createResearcherSubagent()
    const budget = sub.toolResultBudget?.maxTotalBytes ?? 0
    expect(budget).toBeGreaterThan(256_000)
    expect(budget).toBeLessThan(1_000_000)
  })

  test('declares a spawn timeout so a stalled research pass fails the parent loudly instead of hanging forever', () => {
    const sub = createResearcherSubagent()
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createResearcherSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
    expect(k1).not.toBe(k2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createResearcherSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('researcher skill content', () => {
  test('every shipped skill references the researcher neutral output contract (so domain skills compose with it)', () => {
    for (const skill of RESEARCHER_SKILLS) {
      expect(skill.content).toContain('<report>')
    }
  })
})

describe('researcherPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description', () => {
    const result = researcherPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'is the global market for X growing year over year',
      description: 'market growth research',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = researcherPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches scout/reviewer/operator)', () => {
    const result = researcherPayloadSchema.safeParse({ requestId: 'bg_t1', futureField: 42 })
    expect(result.success).toBe(true)
  })
})
