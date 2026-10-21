import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'

import { BROWSER_ENGINE_IDS, BROWSER_EXTENSION_IDS } from '@/browser/registry'

import { browserPayloadSchema, buildBrowserSystemPrompt, createBrowserSubagent, driverSkillPath } from './browser-agent'

describe('browser subagent', () => {
  test('runs the deep profile at low thinking', () => {
    const subagent = createBrowserSubagent({ engines: ['agent-browser'], extensions: [] })
    expect(subagent.profile).toBe('deep')
    expect(subagent.thinkingLevel).toBe('low')
  })

  test('drops a per-spawn profile override so the parent cannot move its tier', () => {
    const parsed = browserPayloadSchema.parse({ prompt: 'open example.com', profile: 'deep' })
    expect(parsed).toEqual({ prompt: 'open example.com' })
  })

  test('every engine and extension skill path points at a shipped SKILL.md', () => {
    for (const id of [...BROWSER_ENGINE_IDS, ...BROWSER_EXTENSION_IDS])
      expect(existsSync(driverSkillPath(id))).toBe(true)
  })

  test('prompt lists only the enabled engines', () => {
    const prompt = buildBrowserSystemPrompt({ engines: ['omowright'], extensions: [] })
    expect(prompt).toContain(driverSkillPath('omowright'))
    expect(prompt).not.toContain(driverSkillPath('agent-browser'))
    expect(prompt).not.toContain(driverSkillPath('browserskill'))
  })

  test('a BrowserSkill-only config still hands the worker its driver skill', () => {
    const prompt = buildBrowserSystemPrompt({ engines: [], extensions: ['browserskill'] })
    expect(prompt).toContain(driverSkillPath('browserskill'))
  })
})
