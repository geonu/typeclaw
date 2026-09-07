import { describe, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { linkWindowsDevTypeclaw, resolveBunLinkedPackage } from './windows-dev-link'

// Build a fake bun global-link layout (<globalDir>/node_modules/typeclaw -> checkout)
// and return both paths plus an env that points resolveBunLinkedPackage at it.
async function fakeBunLink(): Promise<{
  globalDir: string
  checkout: string
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}> {
  const globalDir = await mkdtemp(join(tmpdir(), 'tc-bun-global-'))
  const checkout = await mkdtemp(join(tmpdir(), 'tc-checkout-'))
  await mkdir(join(globalDir, 'node_modules'), { recursive: true })
  await symlink(checkout, join(globalDir, 'node_modules', 'typeclaw'))
  return {
    globalDir,
    checkout,
    env: { BUN_INSTALL_GLOBAL_DIR: globalDir },
    cleanup: async () => {
      await rm(globalDir, { recursive: true, force: true })
      await rm(checkout, { recursive: true, force: true })
    },
  }
}

describe('resolveBunLinkedPackage', () => {
  test('realpaths the global link entry to the checkout', async () => {
    const { checkout, env, cleanup } = await fakeBunLink()
    try {
      expect(resolveBunLinkedPackage('typeclaw', env)).toBe(realpathSync(checkout))
    } finally {
      await cleanup()
    }
  })

  test('returns null when the package is not linked', async () => {
    const globalDir = await mkdtemp(join(tmpdir(), 'tc-bun-global-empty-'))
    try {
      expect(resolveBunLinkedPackage('typeclaw', { BUN_INSTALL_GLOBAL_DIR: globalDir })).toBeNull()
    } finally {
      await rm(globalDir, { recursive: true, force: true })
    }
  })
})

describe('linkWindowsDevTypeclaw', () => {
  test('runs bun link in the checkout and returns the linked target on Windows', async () => {
    const { checkout, env, cleanup } = await fakeBunLink()
    try {
      const linkCalls: string[] = []
      const result = await linkWindowsDevTypeclaw('/repo/typeclaw', {
        platform: 'win32',
        env,
        runBunLink: async (cwd) => {
          linkCalls.push(cwd)
        },
      })

      expect(linkCalls).toEqual(['/repo/typeclaw'])
      expect(result).toBe(realpathSync(checkout))
    } finally {
      await cleanup()
    }
  })

  test('is a no-op on POSIX (does not run bun link)', async () => {
    const linkCalls: string[] = []
    const result = await linkWindowsDevTypeclaw('/repo/typeclaw', {
      platform: 'linux',
      runBunLink: async (cwd) => {
        linkCalls.push(cwd)
      },
    })

    expect(result).toBeNull()
    expect(linkCalls).toHaveLength(0)
  })

  test('falls back to the checkout path when the link target cannot be resolved', async () => {
    const globalDir = await mkdtemp(join(tmpdir(), 'tc-bun-global-unresolved-'))
    try {
      const result = await linkWindowsDevTypeclaw('/repo/typeclaw', {
        platform: 'win32',
        env: { BUN_INSTALL_GLOBAL_DIR: globalDir },
        runBunLink: async () => {},
      })

      expect(result).toBe('/repo/typeclaw')
    } finally {
      await rm(globalDir, { recursive: true, force: true })
    }
  })

  test('tolerates a bun link failure when the checkout is already linked globally', async () => {
    const { checkout, env, cleanup } = await fakeBunLink()
    try {
      const result = await linkWindowsDevTypeclaw(checkout, {
        platform: 'win32',
        env,
        runBunLink: async () => {
          throw new Error('bun link failed: EEXIST: File exists (symlink())')
        },
      })

      expect(result).toBe(realpathSync(checkout))
    } finally {
      await cleanup()
    }
  })

  test('rethrows a bun link failure when the global link points at another checkout', async () => {
    const { env, cleanup } = await fakeBunLink()
    const other = await mkdtemp(join(tmpdir(), 'tc-checkout-other-'))
    try {
      await expect(
        linkWindowsDevTypeclaw(other, {
          platform: 'win32',
          env,
          runBunLink: async () => {
            throw new Error('bun link failed: EEXIST: File exists (symlink())')
          },
        }),
      ).rejects.toThrow('EEXIST')
    } finally {
      await rm(other, { recursive: true, force: true })
      await cleanup()
    }
  })

  test('rethrows a bun link failure when nothing is linked globally', async () => {
    const globalDir = await mkdtemp(join(tmpdir(), 'tc-bun-global-unlinked-'))
    try {
      await expect(
        linkWindowsDevTypeclaw('/repo/typeclaw', {
          platform: 'win32',
          env: { BUN_INSTALL_GLOBAL_DIR: globalDir },
          runBunLink: async () => {
            throw new Error('bun link failed: permission denied')
          },
        }),
      ).rejects.toThrow('permission denied')
    } finally {
      await rm(globalDir, { recursive: true, force: true })
    }
  })
})
