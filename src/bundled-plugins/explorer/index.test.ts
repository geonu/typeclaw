import { describe, expect, test } from 'bun:test'

import { loadPlugins, type ResolvedPlugin } from '@/plugin'

import explorerPlugin from './index'

const RESOLVED: ResolvedPlugin = {
  name: 'explorer',
  version: undefined,
  source: '<bundled>',
  defined: explorerPlugin,
}

describe('explorer plugin', () => {
  test('contributes exactly one public subagent named "explorer"', async () => {
    const { registry } = await loadPlugins({
      entries: [],
      bundled: [RESOLVED],
      agentDir: '/agent',
      configsByName: {},
    })

    expect(registry.subagents.map((s) => s.subagentName).sort()).toEqual(['explorer'])
    const explorer = registry.subagents.find((s) => s.subagentName === 'explorer')
    if (explorer === undefined) throw new Error('explorer subagent missing')
    expect(explorer.subagent.visibility).toBe('public')
  })
})
