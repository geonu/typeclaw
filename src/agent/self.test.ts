import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSelf } from './self'

let agentDir: string

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-ctx-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

describe('loadSelf', () => {
  test('injects IDENTITY.md and SOUL.md contents under their filename headers', async () => {
    // given
    await writeFile(join(agentDir, 'IDENTITY.md'), 'I am Coder. I help Neo write TypeScript.\n')
    await writeFile(join(agentDir, 'SOUL.md'), 'Warm. Direct. Uses contractions.\n')

    // when
    const section = await loadSelf(agentDir)

    // then
    expect(section).toContain('## IDENTITY.md')
    expect(section).toContain('I am Coder. I help Neo write TypeScript.')
    expect(section).toContain('## SOUL.md')
    expect(section).toContain('Warm. Direct. Uses contractions.')
  })

  test('injects IDENTITY before SOUL', async () => {
    // given
    await writeFile(join(agentDir, 'IDENTITY.md'), 'identity body')
    await writeFile(join(agentDir, 'SOUL.md'), 'soul body')

    // when
    const section = await loadSelf(agentDir)

    // then
    expect(section.indexOf('## IDENTITY.md')).toBeLessThan(section.indexOf('## SOUL.md'))
  })

  test('signals [MISSING] with absolute path when a file is absent', async () => {
    // when (neither file exists)
    const section = await loadSelf(agentDir)

    // then
    expect(section).toContain(`[MISSING] Expected at: ${join(agentDir, 'IDENTITY.md')}`)
    expect(section).toContain(`[MISSING] Expected at: ${join(agentDir, 'SOUL.md')}`)
  })

  test('signals [EMPTY] when a file exists but has no content', async () => {
    // given
    await writeFile(join(agentDir, 'IDENTITY.md'), '')
    await writeFile(join(agentDir, 'SOUL.md'), '   \n\n   ')

    // when
    const section = await loadSelf(agentDir)

    // then
    expect(section).toContain('[EMPTY]')
    expect(section).not.toContain('[MISSING]')
  })

  test('truncates files larger than the per-file cap', async () => {
    // given: 20KB file, cap is 12KB
    const huge = 'x'.repeat(20 * 1024)
    await writeFile(join(agentDir, 'IDENTITY.md'), huge)
    await writeFile(join(agentDir, 'SOUL.md'), 'short')

    // when
    const section = await loadSelf(agentDir)

    // then
    expect(section).toContain('[truncated]')
    expect(section.length).toBeLessThan(huge.length)
  })
})
