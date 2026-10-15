import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatCommand, planSelfUpdate, resolveSelfPackageJsonPath } from './index'

const AUTO_DETECT_FAILURE_REASON =
  'Cannot auto-detect how TypeClaw was installed from this checkout. Re-run with --manager=bun, --manager=npm, --manager=pnpm, or --manager=yarn if you want to update a global install.'

const neverExists = (_path: string): boolean => false
const onlyLockfile = (lockfile: string) => (path: string) => path.endsWith(lockfile)

describe('planSelfUpdate global installs', () => {
  test('detects a Bun global install and updates with bun -g', () => {
    const packageJsonPath = join('/home/alice', '.bun', 'install', 'global', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'bun',
      scope: 'global',
      command: ['bun', 'update', '-g', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects an npm global install and updates with npm -g', () => {
    const packageJsonPath = join('/usr/local/lib', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'npm',
      scope: 'global',
      command: ['npm', 'install', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects a pnpm macOS global install and updates with pnpm -g', () => {
    const packageJsonPath = join(
      '/Users/alice',
      'Library',
      'pnpm',
      'global',
      '5',
      'node_modules',
      'typeclaw',
      'package.json',
    )

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'pnpm',
      scope: 'global',
      command: ['pnpm', 'add', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects a pnpm Linux global install and updates with pnpm -g', () => {
    const packageJsonPath = join(
      '/home/alice',
      '.local',
      'share',
      'pnpm',
      'global',
      '5',
      'node_modules',
      'typeclaw',
      'package.json',
    )

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'pnpm',
      scope: 'global',
      command: ['pnpm', 'add', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects a legacy pnpm-global install and updates with pnpm -g', () => {
    const packageJsonPath = join('/home/alice', '.pnpm-global', '5', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'pnpm',
      scope: 'global',
      command: ['pnpm', 'add', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects a classic yarn user global install and updates with yarn global', () => {
    const packageJsonPath = join('/home/alice', '.config', 'yarn', 'global', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'yarn',
      scope: 'global',
      command: ['yarn', 'global', 'upgrade', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
  })

  test('detects a classic yarn system global install and updates with yarn global', () => {
    const packageJsonPath = join(
      '/usr/local/share',
      '.config',
      'yarn',
      'global',
      'node_modules',
      'typeclaw',
      'package.json',
    )

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({
      ok: true,
      manager: 'yarn',
      scope: 'global',
      command: ['yarn', 'global', 'upgrade', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
  })
})

describe('planSelfUpdate local installs', () => {
  test('detects a local install with bun.lock and runs bun update without -g', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({
      manager: 'auto',
      packageJsonPath,
      fileExists: onlyLockfile('bun.lock'),
    })

    expect(plan).toEqual({
      ok: true,
      manager: 'bun',
      scope: 'local',
      command: ['bun', 'update', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
      cwd: join('/work', 'agent'),
    })
  })

  test('detects a local install with bun.lockb (legacy binary lockfile) as bun', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({
      manager: 'auto',
      packageJsonPath,
      fileExists: onlyLockfile('bun.lockb'),
    })

    expect(plan).toMatchObject({ ok: true, manager: 'bun', scope: 'local' })
  })

  test('detects a local install with package-lock.json and runs npm install without -g', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({
      manager: 'auto',
      packageJsonPath,
      fileExists: onlyLockfile('package-lock.json'),
    })

    expect(plan).toEqual({
      ok: true,
      manager: 'npm',
      scope: 'local',
      command: ['npm', 'install', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
      cwd: join('/work', 'agent'),
    })
  })

  test('detects a local install with pnpm-lock.yaml and runs pnpm add without -g', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({
      manager: 'auto',
      packageJsonPath,
      fileExists: onlyLockfile('pnpm-lock.yaml'),
    })

    expect(plan).toEqual({
      ok: true,
      manager: 'pnpm',
      scope: 'local',
      command: ['pnpm', 'add', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
      cwd: join('/work', 'agent'),
    })
  })

  test('detects a local install with yarn.lock and runs yarn upgrade without global', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({
      manager: 'auto',
      packageJsonPath,
      fileExists: onlyLockfile('yarn.lock'),
    })

    expect(plan).toEqual({
      ok: true,
      manager: 'yarn',
      scope: 'local',
      command: ['yarn', 'upgrade', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
      cwd: join('/work', 'agent'),
    })
  })

  test('falls back to bun when a local install has no recognizable lockfile', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toMatchObject({
      ok: true,
      manager: 'bun',
      scope: 'local',
      command: ['bun', 'update', 'typeclaw', '--latest'],
      cwd: join('/work', 'agent'),
    })
  })

  test('prefers bun lockfile over every other lockfile when multiple are present', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({
      manager: 'auto',
      packageJsonPath,
      fileExists: (p) =>
        p.endsWith('bun.lock') ||
        p.endsWith('pnpm-lock.yaml') ||
        p.endsWith('yarn.lock') ||
        p.endsWith('package-lock.json'),
    })

    expect(plan).toMatchObject({ ok: true, manager: 'bun', scope: 'local' })
  })

  test('explicit --manager=npm on a detected local install stays local (no -g)', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'npm', packageJsonPath, fileExists: onlyLockfile('bun.lock') })

    expect(plan).toEqual({
      ok: true,
      manager: 'npm',
      scope: 'local',
      command: ['npm', 'install', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
      cwd: join('/work', 'agent'),
    })
  })

  test('explicit --manager=yarn on a detected local install stays local (no global)', () => {
    const packageJsonPath = join('/work', 'agent', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'yarn', packageJsonPath, fileExists: onlyLockfile('bun.lock') })

    expect(plan).toEqual({
      ok: true,
      manager: 'yarn',
      scope: 'local',
      command: ['yarn', 'upgrade', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
      cwd: join('/work', 'agent'),
    })
  })

  test.skipIf(process.platform === 'win32')('local install at filesystem root resolves install root to "/"', () => {
    // POSIX filesystem root "/" does not model Windows drive roots.
    const packageJsonPath = join('/', 'node_modules', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toMatchObject({ ok: true, scope: 'local', cwd: '/' })
  })
})

describe('planSelfUpdate source checkouts and explicit overrides', () => {
  test('refuses auto mode from a source checkout because it is not a self update', () => {
    const packageJsonPath = join('/work', 'typeclaw', 'package.json')

    const plan = planSelfUpdate({ manager: 'auto', packageJsonPath, fileExists: neverExists })

    expect(plan).toEqual({ ok: false, reason: AUTO_DETECT_FAILURE_REASON })
  })

  test('explicit manager on a source checkout still runs a global update', () => {
    const packageJsonPath = join('/work', 'typeclaw', 'package.json')

    expect(planSelfUpdate({ manager: 'bun', packageJsonPath, fileExists: neverExists })).toEqual({
      ok: true,
      manager: 'bun',
      scope: 'global',
      command: ['bun', 'update', '-g', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
    expect(planSelfUpdate({ manager: 'npm', packageJsonPath, fileExists: neverExists })).toEqual({
      ok: true,
      manager: 'npm',
      scope: 'global',
      command: ['npm', 'install', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
    expect(planSelfUpdate({ manager: 'pnpm', packageJsonPath, fileExists: neverExists })).toEqual({
      ok: true,
      manager: 'pnpm',
      scope: 'global',
      command: ['pnpm', 'add', '-g', 'typeclaw@latest'],
      detectedFrom: packageJsonPath,
    })
    expect(planSelfUpdate({ manager: 'yarn', packageJsonPath, fileExists: neverExists })).toEqual({
      ok: true,
      manager: 'yarn',
      scope: 'global',
      command: ['yarn', 'global', 'upgrade', 'typeclaw', '--latest'],
      detectedFrom: packageJsonPath,
    })
  })
})

describe('formatCommand', () => {
  test('shell-quotes arguments with spaces or shell metacharacters', () => {
    expect(formatCommand(['npm', 'install', '-g', 'typeclaw@latest'])).toBe('npm install -g typeclaw@latest')
    expect(formatCommand(['cmd', 'two words', "can't"])).toBe(`cmd 'two words' 'can'\\''t'`)
  })
})

describe('resolveSelfPackageJsonPath', () => {
  test('points at this package manifest', () => {
    const packageJsonPath = resolveSelfPackageJsonPath()

    expect(packageJsonPath).toEndWith('package.json')
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toMatchObject({ name: 'typeclaw' })
  })
})
