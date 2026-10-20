import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import qaPlugin from './index'
import { QA_SKILLS } from './qa'

const RESOLVED: ResolvedPlugin = {
  name: 'qa',
  version: undefined,
  source: '<bundled>',
  defined: qaPlugin,
}

describe('qa plugin', () => {
  test('contributes exactly one public subagent named "qa" with load_skill and the checkout tool wired', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName)).toEqual(['qa'])
    const qa = registry.subagents[0]
    if (qa === undefined) throw new Error('qa subagent missing')
    expect(qa.subagent.visibility).toBe('public')
    expect(qa.subagent.customTools).toHaveLength(2)
  })

  test('skill names are unique and qa-general is the last-resort fallback', () => {
    const names = QA_SKILLS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.at(-1)).toBe('qa-general')
  })
})
