import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBaseImageVersion, resolveScaffoldVersion } from './cli-version'

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-cli-version-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeAgentPackageJson(dir: string, deps: Record<string, string>): Promise<void> {
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test-agent', dependencies: deps }))
}

async function writeInstalledTypeclaw(agentDir: string, version: string): Promise<void> {
  const installDir = join(agentDir, 'node_modules', 'typeclaw')
  await mkdir(installDir, { recursive: true })
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'typeclaw', version }))
}

describe('resolveScaffoldVersion', () => {
  // The function inspects the path of THIS module's package.json. From the
  // test runner (dev repo), that path has no `/node_modules/` segment, so
  // every assertion in this block must accept `null` as the in-test result.
  // We cannot meaningfully test the "installed" branch without manipulating
  // module resolution, which would test the runtime more than this function.

  test('returns null when typeclaw is running from a dev checkout (no node_modules in CLI path)', () => {
    // when: invoked from the test runner (which loads cli-version.ts from src/, not node_modules)
    // then: scaffold falls back to file: dep
    expect(resolveScaffoldVersion()).toBeNull()
  })
})

describe('resolveBaseImageVersion', () => {
  test('returns the installed typeclaw version from node_modules when present (matches runtime)', async () => {
    await withTmpDir(async (dir) => {
      // given: an agent with bun install completed, node_modules/typeclaw at 0.1.1
      await writeAgentPackageJson(dir, { typeclaw: '^0.1.2' })
      await writeInstalledTypeclaw(dir, '0.1.1')

      // when: resolving the base image version
      // then: returns the INSTALLED version (0.1.1), not the spec range (0.1.2)
      expect(resolveBaseImageVersion(dir)).toBe('0.1.1')
    })
  })

  test('accepts exact, caret, tilde, and equals version specs', async () => {
    for (const spec of ['0.1.1', '^0.1.1', '~0.1.1', '=0.1.1']) {
      await withTmpDir(async (dir) => {
        await writeAgentPackageJson(dir, { typeclaw: spec })
        expect(resolveBaseImageVersion(dir)).toBe('0.1.1')
      })
    }
  })

  test('returns null for file: specs (dev mode — local checkout)', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: 'file:../typeclaw' })
      expect(resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('returns null for link: specs', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: 'link:../typeclaw' })
      expect(resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('returns null for ranges, dist-tags, and aliases that do not map 1:1 to a GHCR tag', async () => {
    const ambiguous = [
      'latest',
      '*',
      '>=0.1.0',
      '0.1.x',
      'workspace:*',
      'github:typeclaw/typeclaw',
      'npm:typeclaw@0.1.1',
    ]
    for (const spec of ambiguous) {
      await withTmpDir(async (dir) => {
        await writeAgentPackageJson(dir, { typeclaw: spec })
        expect(resolveBaseImageVersion(dir)).toBeNull()
      })
    }
  })

  test('returns null when agent package.json is missing (fresh tmp dirs, scaffolding-in-progress)', async () => {
    await withTmpDir(async (dir) => {
      expect(resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('returns null when typeclaw is not in dependencies', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { 'some-other-dep': '^1.0.0' })
      expect(resolveBaseImageVersion(dir)).toBeNull()
    })
  })

  test('rejects an installed-typeclaw package.json with a non-release version (avoids pinning prerelease tags)', async () => {
    await withTmpDir(async (dir) => {
      await writeAgentPackageJson(dir, { typeclaw: '^0.1.1' })
      await writeInstalledTypeclaw(dir, '0.2.0-beta.1')
      // when: installed version is a prerelease that has no GHCR tag
      // then: falls back to the dep spec
      expect(resolveBaseImageVersion(dir)).toBe('0.1.1')
    })
  })
})
