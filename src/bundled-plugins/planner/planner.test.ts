import { describe, expect, test } from 'bun:test'

import {
  PLANNER_DEFAULT_PLAN_DIR,
  PLANNER_SKILLS,
  PLANNER_SYSTEM_PROMPT,
  createPlannerSubagent,
  plannerPayloadSchema,
} from './planner'

describe('planner subagent — load-bearing prompt phrases', () => {
  test.each(
    [
      '<plan-summary>',
      '<path>',
      '<summary>',
      '<verdict>',
      '<review-suggestion>',
      '<questions>',
      'ready',
      'needs-input',
      'infeasible',
    ].map((phrase) => [phrase] as const),
  )('prompt contains %s', (phrase) => {
    const haystack = PLANNER_SYSTEM_PROMPT.toLowerCase()
    expect(haystack).toContain(phrase.toLowerCase())
  })

  test('prompt names the structured plan-summary shape explicitly (so the parent can parse path + verdict)', () => {
    expect(PLANNER_SYSTEM_PROMPT).toContain('<question id=')
    expect(PLANNER_SYSTEM_PROMPT).toContain('blocking="true"')
    expect(PLANNER_SYSTEM_PROMPT).toContain('## Open Questions')
  })
})

describe('planner subagent declaration', () => {
  test('uses the deep model profile (quality over speed for planning)', () => {
    const sub = createPlannerSubagent()
    expect(sub.profile).toBe('deep')
  })

  test('does NOT require a specific permission (member with generic subagent.spawn can spawn it)', () => {
    const sub = createPlannerSubagent()
    expect(sub.requiresSpecificPermission ?? false).toBe(false)
  })

  test('declares canSpawnSubagents=true (deep-model planner offloads bulk research to cheaper workers)', () => {
    const sub = createPlannerSubagent()
    expect(sub.canSpawnSubagents).toBe(true)
  })

  test('tools include write (one plan artifact) plus the read-only set, but NOT edit', () => {
    const sub = createPlannerSubagent()
    const toolNames = (sub.tools ?? []).map((t) => t.__builtinTool).sort()
    expect(toolNames).toEqual(['bash', 'find', 'grep', 'ls', 'read', 'web_fetch', 'web_search', 'write'])
    expect(toolNames).toContain('write')
    expect(toolNames).not.toContain('edit')
  })

  test('customTools contains exactly one tool: load_skill (the runtime-skill-loader)', () => {
    const sub = createPlannerSubagent()
    expect(sub.customTools).toBeDefined()
    expect(sub.customTools).toHaveLength(1)
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.description).toContain('`project`')
    expect(loadSkill.description).toContain('`general`')
  })

  test('load_skill parameter schema accepts the shipped skill names and rejects unknown ones', () => {
    const sub = createPlannerSubagent()
    const loadSkill = sub.customTools?.[0]
    if (loadSkill === undefined) throw new Error('load_skill tool missing')
    expect(loadSkill.parameters.safeParse({ name: 'project' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'general' }).success).toBe(true)
    expect(loadSkill.parameters.safeParse({ name: 'engineering' }).success).toBe(false)
    expect(loadSkill.parameters.safeParse({ name: '' }).success).toBe(false)
  })

  test('declares a tool-result budget so a runaway subagent cannot exhaust parent context', () => {
    const sub = createPlannerSubagent()
    expect(sub.toolResultBudget).toBeDefined()
    expect(sub.toolResultBudget?.maxTotalBytes).toBeGreaterThan(0)
  })

  test('tool-result budget covers write and load_skill (the plan body and loaded skills count against the cap)', () => {
    const sub = createPlannerSubagent()
    expect(sub.toolResultBudget?.toolNames).toContain('write')
    expect(sub.toolResultBudget?.toolNames).toContain('load_skill')
  })

  test('budget sits between explorer (256KB) and operator (1MB) — read-mostly deep analysis, bounded', () => {
    const sub = createPlannerSubagent()
    const budget = sub.toolResultBudget?.maxTotalBytes ?? 0
    expect(budget).toBeGreaterThan(256_000)
    expect(budget).toBeLessThan(1_000_000)
  })

  test('declares a spawn timeout so a stalled plan fails the parent loudly instead of hanging forever', () => {
    const sub = createPlannerSubagent()
    expect(sub.timeoutMs).toBeGreaterThan(0)
  })

  test('inFlightKey returns distinct values for distinct requestId payloads (parallel spawns must not coalesce)', () => {
    const sub = createPlannerSubagent()
    const k1 = sub.inFlightKey?.({ requestId: 'bg_a' })
    const k2 = sub.inFlightKey?.({ requestId: 'bg_b' })
    expect(k1).toBe('bg_a')
    expect(k2).toBe('bg_b')
    expect(k1).not.toBe(k2)
  })

  test('inFlightKey falls back to a random value when no requestId is provided (no accidental coalescing)', () => {
    const sub = createPlannerSubagent()
    const k1 = sub.inFlightKey?.({})
    const k2 = sub.inFlightKey?.({})
    expect(k1).not.toBe(k2)
  })
})

describe('plannerPayloadSchema', () => {
  test('accepts a full payload with requestId + prompt + description + outputPath', () => {
    const result = plannerPayloadSchema.safeParse({
      requestId: 'bg_t1',
      prompt: 'plan a 7-day Tokyo trip',
      description: 'trip plan',
      outputPath: 'workspace/plans/tokyo.md',
    })
    expect(result.success).toBe(true)
  })

  test('accepts a payload with only requestId (spawn-tool minimum)', () => {
    const result = plannerPayloadSchema.safeParse({ requestId: 'bg_t1' })
    expect(result.success).toBe(true)
  })

  test('accepts a public/ outputPath (the safe zone for low-trust callers)', () => {
    const result = plannerPayloadSchema.safeParse({ outputPath: 'public/plans/trip.md' })
    expect(result.success).toBe(true)
  })

  test('rejects an absolute outputPath (must stay inside the agent folder)', () => {
    const result = plannerPayloadSchema.safeParse({ outputPath: '/etc/passwd' })
    expect(result.success).toBe(false)
  })

  test('rejects a traversal outputPath (no .. escape out of the agent folder)', () => {
    expect(plannerPayloadSchema.safeParse({ outputPath: '../../etc/passwd' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: 'workspace/../../secrets.json' }).success).toBe(false)
  })

  test('rejects blank and directory-like outputPath (must name a file, not a directory)', () => {
    // The planner writes a file; '', '.', and trailing-separator paths are not
    // files and would waste a run before failing at write. (Review fix.)
    expect(plannerPayloadSchema.safeParse({ outputPath: '' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: '   ' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: '.' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: './' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: 'workspace/plans/' }).success).toBe(false)
    expect(plannerPayloadSchema.safeParse({ outputPath: 'workspace/plans/.' }).success).toBe(false)
  })

  test('still accepts a normal nested file path (regression guard for the tightened refine)', () => {
    expect(plannerPayloadSchema.safeParse({ outputPath: 'workspace/plans/tokyo-trip.md' }).success).toBe(true)
    expect(plannerPayloadSchema.safeParse({ outputPath: 'plan.md' }).success).toBe(true)
  })

  test('passes through unknown fields (forward-compat with future spawn-tool params, matches reviewer)', () => {
    const result = plannerPayloadSchema.safeParse({ requestId: 'bg_t1', priorDraftPath: 'workspace/plans/x.md' })
    expect(result.success).toBe(true)
  })
})

describe('planner default plan dir', () => {
  test('defaults to a public/ subdir (universally writable, so the default works for any caller role)', () => {
    // Review fix (#661): the default must be writable by EVERY role. workspace/
    // is hidden from low-trust callers, so a workspace/ default would deny the
    // write for a guest-spawned planner and break the "always write a file"
    // contract. public/ is the one zone every role can write.
    expect(PLANNER_DEFAULT_PLAN_DIR).toBe('public/plans')
    expect(PLANNER_DEFAULT_PLAN_DIR.startsWith('public/')).toBe(true)
  })
})

describe('planner skill content', () => {
  test('every shipped skill references the neutral plan-summary contract (so domain skills compose with the universal shape)', () => {
    for (const skill of PLANNER_SKILLS) {
      expect(skill.content).toContain('<plan-summary>')
    }
  })
})
