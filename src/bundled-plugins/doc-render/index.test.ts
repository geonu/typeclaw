import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { noopPermissionService } from '@/permissions'
import { createPluginContext, createPluginLogger } from '@/plugin/context'

import docRenderPlugin, { renderScriptPath, templateLibPath } from './index'

describe('doc-render plugin', () => {
  test('contributes the skill directory and no tools or hooks', async () => {
    const exports = await bootPlugin()

    expect((exports.skillsDirs ?? []).map((dir) => dir.split(sep).join('/'))).toEqual([
      expect.stringContaining('bundled-plugins/doc-render/skills'),
    ])
    expect(exports.tools).toBeUndefined()
    expect(exports.hooks).toBeUndefined()
  })

  test('the bundled render script exists on disk', () => {
    expect(existsSync(renderScriptPath())).toBe(true)
  })

  test('the bundled theme library exists on disk', () => {
    expect(existsSync(templateLibPath())).toBe(true)
  })
})

describe('typeclaw-render-pdf skill', () => {
  const skillPath = join(import.meta.dir, 'skills', 'typeclaw-render-pdf', 'SKILL.md')

  test('ships with YAML frontmatter naming the skill', async () => {
    const raw = await readFile(skillPath, 'utf8')

    expect(raw.startsWith('---\n')).toBe(true)
    const frontmatterEnd = raw.indexOf('\n---\n', 4)
    expect(frontmatterEnd).toBeGreaterThan(0)
    const frontmatter = raw.slice(4, frontmatterEnd)
    expect(frontmatter).toMatch(/^name:\s*typeclaw-render-pdf\s*$/m)
    expect(frontmatter).toMatch(/^description:\s*\S/m)
  })
})

async function bootPlugin() {
  return docRenderPlugin.plugin(
    createPluginContext({
      name: 'doc-render',
      version: undefined,
      agentDir: '/agent',
      config: undefined,
      logger: createPluginLogger('doc-render'),
      permissions: noopPermissionService,
      spawnSubagent: async () => {},
      isBooted: () => true,
    }),
  )
}
