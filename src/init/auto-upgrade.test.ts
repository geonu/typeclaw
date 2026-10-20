import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  autoUpgradeTypeclawDep,
  describeAutoUpgrade,
  expectedInstalledAfterUpgrade,
  outcomeForcesInstall,
  outcomeRequiresForceInstall,
  readInstalledTypeclawVersionFromAgent,
} from './auto-upgrade'

describe('outcomeRequiresForceInstall', () => {
  test('forces a reinstall when switching a local spec back to a registry range', () => {
    expect(
      outcomeRequiresForceInstall({
        kind: 'spec-rewritten',
        from: 'file:../typeclaw',
        to: '^1.2.3',
        cliVersion: '1.2.3',
      }),
    ).toBe(true)
    expect(
      outcomeRequiresForceInstall({ kind: 'spec-rewritten', from: 'link:typeclaw', to: '^1.2.3', cliVersion: '1.2.3' }),
    ).toBe(true)
    expect(outcomeRequiresForceInstall({ kind: 'relinked-to-local', from: '^1.2.3', to: 'file:../typeclaw' })).toBe(
      true,
    )
  })

  test('leaves registry-to-registry upgrades to bun update', () => {
    expect(
      outcomeRequiresForceInstall({ kind: 'spec-rewritten', from: '^1.1.0', to: '^1.2.3', cliVersion: '1.2.3' }),
    ).toBe(false)
    expect(outcomeRequiresForceInstall({ kind: 'up-to-date', installedVersion: '1.2.3' })).toBe(false)
  })
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-auto-upgrade-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackageJson(content: Record<string, unknown>): Promise<void> {
  await writeFile(join(root, 'package.json'), `${JSON.stringify(content, null, 2)}\n`)
}

async function writeInstalledTypeclaw(version: string): Promise<void> {
  const installDir = join(root, 'node_modules', 'typeclaw')
  await mkdir(installDir, { recursive: true })
  await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'typeclaw', version }))
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, 'package.json'), 'utf8')
  return JSON.parse(raw) as Record<string, unknown>
}

describe('autoUpgradeTypeclawDep — skipped outcomes', () => {
  test('returns skipped-dev-mode when scaffold version is null (running from typeclaw source repo)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: null })

    expect(outcome).toEqual({ kind: 'skipped-dev-mode' })
  })

  test('returns skipped-no-dep when package.json is absent', async () => {
    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-no-dep when package.json has no dependencies field at all', async () => {
    await writePackageJson({ name: 'foo' })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-no-dep when typeclaw is in devDependencies only (not dependencies)', async () => {
    await writePackageJson({ devDependencies: { typeclaw: '^0.1.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-no-dep when package.json has dependencies but no typeclaw key', async () => {
    await writePackageJson({ dependencies: { other: '^1.0.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-no-dep for an array-typed package.json (parses as JSON but is not an object)', async () => {
    await writeFile(join(root, 'package.json'), '[]')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-no-dep for corrupt JSON (never throws)', async () => {
    await writeFile(join(root, 'package.json'), '{ "name": "broken", "dependencies":')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'skipped-no-dep' })
  })

  test('returns skipped-non-release-spec for dist-tag / range / glob / github: specs', async () => {
    // file:/link: are intentionally excluded — under an npm CLI they relink to
    // npm (covered in the reconcile suite), so they are NOT skipped specs.
    for (const spec of [
      'latest',
      'workspace:*',
      'npm:typeclaw@0.1.0',
      '>=0.1.0',
      '*',
      '0.1.x',
      'github:typeclaw/typeclaw',
    ]) {
      await writePackageJson({ dependencies: { typeclaw: spec } })

      const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

      expect(outcome).toEqual({ kind: 'skipped-non-release-spec', declared: spec })
    }
  })
})

describe('autoUpgradeTypeclawDep — local/npm reconcile', () => {
  test('npm CLI + file: spec → relinks to ^version (spec-rewritten)', async () => {
    await writePackageJson({ dependencies: { typeclaw: 'file:../typeclaw' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.4.0' })

    expect(outcome).toMatchObject({ kind: 'spec-rewritten', from: 'file:../typeclaw', to: '^0.4.0' })
    expect((await readPackageJson()).dependencies).toEqual({ typeclaw: '^0.4.0' })
  })

  test('npm CLI + link: spec → relinks to ^version (spec-rewritten)', async () => {
    await writePackageJson({ dependencies: { typeclaw: 'link:typeclaw' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.4.0' })

    expect(outcome).toMatchObject({ kind: 'spec-rewritten', to: '^0.4.0' })
  })

  test('local CLI + npm range → relinks to the local spec (relinked-to-local)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: null, localSpec: 'file:../typeclaw' })

    expect(outcome).toMatchObject({ kind: 'relinked-to-local', from: '^0.1.0', to: 'file:../typeclaw' })
    expect((await readPackageJson()).dependencies).toEqual({ typeclaw: 'file:../typeclaw' })
  })

  test('local CLI + spec already matching the local spec → no-op (skipped-dev-mode)', async () => {
    await writePackageJson({ dependencies: { typeclaw: 'file:../typeclaw' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: null, localSpec: 'file:../typeclaw' })

    expect(outcome).toEqual({ kind: 'skipped-dev-mode' })
  })

  test('local CLI + exact pin → left untouched (skipped-dev-mode)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.5' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: null, localSpec: 'file:../typeclaw' })

    expect(outcome).toEqual({ kind: 'skipped-dev-mode' })
    expect((await readPackageJson()).dependencies).toEqual({ typeclaw: '0.1.5' })
  })
})

describe('autoUpgradeTypeclawDep — upgrade-only invariant', () => {
  test('installed > CLI and range satisfies CLI → up-to-date (never downgrades)', async () => {
    // given: installed 0.1.5, spec ^0.1.0 (includes CLI 0.1.2), CLI 0.1.2
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.5')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.5' })
  })

  test('installed > CLI and range does NOT satisfy CLI → up-to-date (never downgrades)', async () => {
    // given: installed 0.1.5, spec ^0.1.5 (excludes CLI 0.1.2), CLI 0.1.2
    await writePackageJson({ dependencies: { typeclaw: '^0.1.5' } })
    await writeInstalledTypeclaw('0.1.5')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.5' })
  })

  test('installed == CLI → up-to-date', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })

  test('installed < CLI but range satisfies CLI → reinstall-needed (the in-range upgrade case)', async () => {
    // The canonical regression: `bun -g update typeclaw` moved the global CLI from 0.1.0
    // to 0.1.2, the agent's package.json says `^0.1.0` which still permits 0.1.2, but
    // node_modules/typeclaw is still 0.1.0 because `bun install` honors the lockfile.
    // We MUST force a `bun update`, not just `bun install`.
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })
    // and: package.json is NOT modified — the existing range still permits the new CLI.
    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('^0.1.0')
  })

  test('installed < CLI and range does NOT satisfy CLI → spec-rewritten (pre-1.0 minor bump)', async () => {
    // given: pre-1.0 caret ^0.1.0 excludes 0.2.0 (the entire bug class auto-upgrade fixes).
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    expect(outcome).toEqual({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' })
    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('^0.2.0')
  })

  test('spec-rewritten across a major boundary (^1.x → ^2.x)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^1.5.0' } })
    await writeInstalledTypeclaw('1.5.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^2.0.0' })

    expect(outcome).toEqual({ kind: 'spec-rewritten', from: '^1.5.0', to: '^2.0.0', cliVersion: '2.0.0' })
  })

  test('half-applied rewrite recovery: package.json points ahead but node_modules is stale → reinstall-needed', async () => {
    // Scenario: a previous `typeclaw start` rewrote package.json to ^0.2.0 but the
    // subsequent `bun update` failed. We must not treat the declared spec as ground
    // truth; the installed version is the source of truth. Otherwise the next start
    // would silently believe everything is fine and pin a stale Dockerfile.
    await writePackageJson({ dependencies: { typeclaw: '^0.2.0' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '0.1.2', to: '0.2.0' })
  })

  test('fresh agent (no node_modules) with in-range spec → up-to-date (ensureDeps installs separately)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.2' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })

  test('fresh agent (no node_modules) with range floor > CLI → up-to-date with floor as installedVersion', async () => {
    // Per "never downgrade": when nothing is installed, the declared floor is our best
    // estimate of "what would land if bun install ran." If that's already >= CLI, no-op.
    await writePackageJson({ dependencies: { typeclaw: '^0.1.5' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.5' })
  })
})

describe('autoUpgradeTypeclawDep — exact pin handling', () => {
  test('exact pin matching CLI, installed also matches → up-to-date', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.2' } })
    await writeInstalledTypeclaw('0.1.2')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })

  test('exact pin matching CLI but installed is stale → reinstall-needed (this is BLOCKING regression #3)', async () => {
    // Without this branch, the original production bug would still bite: a user who
    // pins exactly to 0.1.2 but has 0.1.0 in node_modules would see refreshDockerfile
    // pin :0.1.0 from resolveBaseImageVersion.
    await writePackageJson({ dependencies: { typeclaw: '0.1.2' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })
  })

  test('exact pin matching CLI with no node_modules → reinstall-needed', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.2' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '<missing>', to: '0.1.2' })
  })

  test('exact pin LOWER than CLI → exact-pin-respected (user wants the older version)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' })
    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('0.1.0')
  })

  test('exact pin HIGHER than CLI → up-to-date (never downgrade — installed > CLI wins)', async () => {
    // Symmetric to "lower". The user pinned to a newer version than the global CLI;
    // installed matches the pin and is ahead of CLI, so the upgrade-only check
    // returns up-to-date before we ever reach the exact-pin branch.
    await writePackageJson({ dependencies: { typeclaw: '0.1.5' } })
    await writeInstalledTypeclaw('0.1.5')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.5' })
  })

  test('exact pin HIGHER than CLI, no node_modules → exact-pin-respected (no on-disk version to defer to)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '0.1.5' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'exact-pin-respected', declared: '0.1.5', cliVersion: '0.1.2' })
  })

  test('treats =X.Y.Z as exact pin', async () => {
    await writePackageJson({ dependencies: { typeclaw: '=0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    expect(outcome).toEqual({ kind: 'exact-pin-respected', declared: '=0.1.0', cliVersion: '0.1.2' })
  })
})

describe('autoUpgradeTypeclawDep — tilde ranges and other range parsers', () => {
  test('~0.1.0 includes CLI 0.1.5 → reinstall-needed', async () => {
    await writePackageJson({ dependencies: { typeclaw: '~0.1.0' } })
    await writeInstalledTypeclaw('0.1.0')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.5' })

    expect(outcome).toEqual({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.5' })
  })

  test('~0.1.2 excludes CLI 0.2.0 → spec-rewritten', async () => {
    await writePackageJson({ dependencies: { typeclaw: '~0.1.2' } })

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    expect(outcome).toEqual({ kind: 'spec-rewritten', from: '~0.1.2', to: '^0.2.0', cliVersion: '0.2.0' })
  })
})

describe('writeDepSpec via autoUpgradeTypeclawDep — formatting and scope', () => {
  test('preserves user formatting (2-space, key order, trailing newline)', async () => {
    const original = `{
  "name": "my-agent",
  "type": "module",
  "dependencies": {
    "typeclaw": "^0.1.0",
    "zod": "^4.0.0"
  }
}
`
    await writeFile(join(root, 'package.json'), original)

    await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    const after = await readFile(join(root, 'package.json'), 'utf8')
    expect(after).toBe(`{
  "name": "my-agent",
  "type": "module",
  "dependencies": {
    "typeclaw": "^0.2.0",
    "zod": "^4.0.0"
  }
}
`)
  })

  test('preserves 4-space indentation', async () => {
    const original = `{
    "name": "my-agent",
    "dependencies": {
        "typeclaw": "^0.1.0"
    }
}
`
    await writeFile(join(root, 'package.json'), original)

    await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    const after = await readFile(join(root, 'package.json'), 'utf8')
    expect(after).toContain('"typeclaw": "^0.2.0"')
    // and: the 4-space indent inside dependencies is preserved exactly
    expect(after).toContain('        "typeclaw": "^0.2.0"')
  })

  test('preserves tab indentation', async () => {
    const original = '{\n\t"name": "my-agent",\n\t"dependencies": {\n\t\t"typeclaw": "^0.1.0"\n\t}\n}\n'
    await writeFile(join(root, 'package.json'), original)

    await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    const after = await readFile(join(root, 'package.json'), 'utf8')
    expect(after).toContain('\t\t"typeclaw": "^0.2.0"')
  })

  test('does NOT rewrite devDependencies.typeclaw when it appears before dependencies.typeclaw', async () => {
    // Regression guard for the BLOCKING bug Oracle caught: the original unscoped regex
    // would silently rewrite the FIRST occurrence of `"typeclaw": "..."` in the file,
    // even if that's in devDependencies. The scoped tokenizer must edit only inside
    // the dependencies object.
    const original = `{
  "name": "my-agent",
  "devDependencies": {
    "typeclaw": "0.1.0"
  },
  "dependencies": {
    "typeclaw": "^0.1.0"
  }
}
`
    await writeFile(join(root, 'package.json'), original)

    await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    const after = await readFile(join(root, 'package.json'), 'utf8')
    expect(after).toContain('"devDependencies": {\n    "typeclaw": "0.1.0"\n  }')
    expect(after).toContain('"dependencies": {\n    "typeclaw": "^0.2.0"\n  }')
  })

  test('handles minified package.json (no whitespace) without corrupting other keys', async () => {
    const original = `{"name":"my-agent","dependencies":{"typeclaw":"^0.1.0","zod":"^4.0.0"}}`
    await writeFile(join(root, 'package.json'), original)

    await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.2.0' })

    const pkg = await readPackageJson()
    expect((pkg.dependencies as Record<string, string>).typeclaw).toBe('^0.2.0')
    expect((pkg.dependencies as Record<string, string>).zod).toBe('^4.0.0')
  })

  test('rejects an installed-typeclaw with a non-release version (prerelease tag)', async () => {
    await writePackageJson({ dependencies: { typeclaw: '^0.1.0' } })
    await writeInstalledTypeclaw('0.2.0-beta.1')

    const outcome = await autoUpgradeTypeclawDep({ cwd: root, scaffoldVersion: '^0.1.2' })

    // and: prerelease installed is treated as "not a release we can compare," so
    // we fall back to the declared range floor for the up-to-date check.
    expect(outcome).toEqual({ kind: 'up-to-date', installedVersion: '0.1.2' })
  })
})

describe('outcomeForcesInstall', () => {
  test('returns true only for outcomes that mutate node_modules', () => {
    expect(outcomeForcesInstall({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' })).toBe(
      true,
    )
    expect(outcomeForcesInstall({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })).toBe(true)

    expect(outcomeForcesInstall({ kind: 'up-to-date', installedVersion: '0.1.2' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-dev-mode' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-no-dep' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-non-release-spec', declared: 'latest' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'skipped-already-running' })).toBe(false)
    expect(outcomeForcesInstall({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' })).toBe(false)
  })
})

describe('expectedInstalledAfterUpgrade', () => {
  test('returns the CLI version for spec-rewritten (the post-install verification target)', () => {
    expect(
      expectedInstalledAfterUpgrade({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' }),
    ).toBe('0.2.0')
  })

  test('returns the target version for reinstall-needed', () => {
    expect(expectedInstalledAfterUpgrade({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })).toBe('0.1.2')
  })

  test('returns null for outcomes that did not trigger an install', () => {
    expect(expectedInstalledAfterUpgrade({ kind: 'up-to-date', installedVersion: '0.1.2' })).toBeNull()
    expect(expectedInstalledAfterUpgrade({ kind: 'skipped-dev-mode' })).toBeNull()
    expect(expectedInstalledAfterUpgrade({ kind: 'skipped-no-dep' })).toBeNull()
    expect(
      expectedInstalledAfterUpgrade({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' }),
    ).toBeNull()
  })
})

describe('describeAutoUpgrade', () => {
  test('returns the upgrade line for spec-rewritten and reinstall-needed', () => {
    expect(describeAutoUpgrade({ kind: 'spec-rewritten', from: '^0.1.0', to: '^0.2.0', cliVersion: '0.2.0' })).toBe(
      'Upgrading agent typeclaw ^0.1.0 → ^0.2.0 to match CLI',
    )
    expect(describeAutoUpgrade({ kind: 'reinstall-needed', from: '0.1.0', to: '0.1.2' })).toBe(
      'Upgrading agent typeclaw 0.1.0 → 0.1.2 to match CLI',
    )
  })

  test('returns the warning line for exact-pin-respected', () => {
    expect(describeAutoUpgrade({ kind: 'exact-pin-respected', declared: '0.1.0', cliVersion: '0.1.2' })).toContain(
      'exact-pinned',
    )
  })

  test('returns empty string for no-op outcomes (silent on no-op)', () => {
    expect(describeAutoUpgrade({ kind: 'up-to-date', installedVersion: '0.1.2' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-dev-mode' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-no-dep' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-already-running' })).toBe('')
    expect(describeAutoUpgrade({ kind: 'skipped-non-release-spec', declared: 'latest' })).toBe('')
  })
})

describe('readInstalledTypeclawVersionFromAgent (post-install verification helper)', () => {
  test('returns the version when node_modules/typeclaw/package.json carries a release version', async () => {
    await writeInstalledTypeclaw('0.1.2')

    expect(readInstalledTypeclawVersionFromAgent(root)).toBe('0.1.2')
  })

  test('returns null when node_modules/typeclaw is missing', async () => {
    expect(readInstalledTypeclawVersionFromAgent(root)).toBeNull()
  })

  test('returns null for a prerelease version (cannot map to a GHCR release tag)', async () => {
    await writeInstalledTypeclaw('0.2.0-beta.1')

    expect(readInstalledTypeclawVersionFromAgent(root)).toBeNull()
  })
})
