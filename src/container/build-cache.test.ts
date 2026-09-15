import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { acquireManagedBuildCache, type ManagedBuildCacheLease } from './build-cache'
import type { DockerExec } from './shared'

type FakeDocker = {
  exec: DockerExec
  calls: Array<{ args: string[]; env?: Record<string, string | undefined> }>
  setDaemonId: (daemonId: string) => void
  setBuilderRmFails: (fails: boolean) => void
}

function fakeDocker(initialDaemonId = 'daemon-a'): FakeDocker {
  const calls: FakeDocker['calls'] = []
  let daemonId = initialDaemonId
  let builderRmFails = false
  const builders = new Set<string>()
  const exec: DockerExec = async (args, options) => {
    calls.push({ args, env: options?.env })
    if (args[0] === 'info') return { exitCode: 0, stdout: `${daemonId}\n`, stderr: '' }
    if (args[0] === 'buildx' && args[1] === 'inspect') {
      return builders.has(args[2] ?? '')
        ? { exitCode: 0, stdout: 'owned builder\n', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'not found' }
    }
    if (args[0] === 'buildx' && args[1] === 'create') {
      builders.add(args.at(-1) ?? '')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'buildx' && args[1] === 'rm') {
      if (builderRmFails) return { exitCode: 1, stdout: '', stderr: 'builder removal failed' }
      builders.delete(args[2] ?? '')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
  }
  return {
    exec,
    calls,
    setDaemonId: (next) => (daemonId = next),
    setBuilderRmFails: (fails) => (builderRmFails = fails),
  }
}

async function acquire(
  stateDir: string,
  docker: FakeDocker,
  generationId: string,
  cacheScope = 'agent-a',
): Promise<ManagedBuildCacheLease> {
  const result = await acquireManagedBuildCache({
    exec: docker.exec,
    stateDir,
    cacheScope,
    randomBuilderName: () =>
      cacheScope === 'agent-a' ? 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa' : 'typeclaw-bbbbbbbbbbbbbbbbbbbbbbbb',
    randomGenerationId: () => generationId,
  })
  if (!result.ok) throw new Error(result.reason)
  return result.lease
}

async function exported(lease: ManagedBuildCacheLease): Promise<void> {
  await mkdir(lease.stagingPath, { mode: 0o700 })
  await writeFile(join(lease.stagingPath, 'index.json'), '{}')
}

async function onlyGeneration(lease: ManagedBuildCacheLease): Promise<string> {
  const generations = await readdir(join(lease.cacheRoot, 'generations'))
  expect(generations).toHaveLength(1)
  return generations[0]!
}

test('first successful build exports only and leaves exactly one active generation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const lease = await acquire(stateDir, docker, '11111111111111111111111111111111')

    expect(lease.cacheArgs).toEqual(['--cache-to', `type=local,dest=${lease.stagingPath},mode=min`])
    await exported(lease)
    expect(await lease.finish(true)).toEqual({ warnings: [] })

    expect(await onlyGeneration(lease)).toBe('11111111111111111111111111111111')
    expect(JSON.parse(await readFile(join(lease.cacheRoot, 'active.json'), 'utf8'))).toEqual({
      version: 1,
      generationId: '11111111111111111111111111111111',
    })
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('next build imports the active cache, exports fresh, and deletes the prior generation on success', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)
    const firstPath = first.stagingPath

    const second = await acquire(stateDir, docker, '22222222222222222222222222222222')
    expect(second.cacheArgs).toEqual([
      '--cache-from',
      `type=local,src=${firstPath}`,
      '--cache-to',
      `type=local,dest=${second.stagingPath},mode=min`,
    ])
    await exported(second)
    await second.finish(true)

    expect(await onlyGeneration(second)).toBe('22222222222222222222222222222222')
    expect(existsSync(firstPath)).toBe(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('failed builds delete staging and retain the previous active generation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)

    const failed = await acquire(stateDir, docker, '22222222222222222222222222222222')
    await exported(failed)
    await failed.finish(false)

    expect(await onlyGeneration(failed)).toBe('11111111111111111111111111111111')
    expect(existsSync(failed.stagingPath)).toBe(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('acquire removes stale generations while retaining only the valid active generation', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)
    await mkdir(join(first.cacheRoot, 'generations', '99999999999999999999999999999999'))

    const second = await acquire(stateDir, docker, '22222222222222222222222222222222')
    expect(await readdir(join(second.cacheRoot, 'generations'))).toEqual(['11111111111111111111111111111111'])
    await second.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('daemon mismatch refuses promotion and scoped prune while preserving the old active cache', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)

    const second = await acquire(stateDir, docker, '22222222222222222222222222222222')
    await exported(second)
    docker.calls.length = 0
    docker.setDaemonId('daemon-replacement')
    const result = await second.finish(true)

    expect(result.warnings.join(' ')).toContain('daemon identity changed')
    expect(await onlyGeneration(second)).toBe('11111111111111111111111111111111')
    expect(docker.calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'prune')).toBe(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('rejects invalid generated builder and cache generation names', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const badBuilder = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => 'default',
    })
    expect(badBuilder).toEqual({ ok: false, reason: 'generated an invalid managed builder name' })

    const badGeneration = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa',
      randomGenerationId: () => `${'a'.repeat(32)}\n`,
    })
    expect(badGeneration).toEqual({ ok: false, reason: 'generated an invalid managed cache generation ID' })
    expect(docker.calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toBe(true)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('removes the exact owned builder when ready-state persistence fails after create', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const result = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa',
      faultInjection: {
        beforeReadyPersist: () => {
          throw new Error('injected ready-state persistence failure')
        },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unexpected managed cache lease')
    expect(result.reason).toContain('injected ready-state persistence failure')
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toEqual([
      {
        args: ['buildx', 'rm', 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa'],
        env: expect.objectContaining({ BUILDX_CONFIG: expect.any(String) }),
      },
    ])
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('leases serialize only for the same cache scope and daemon', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const dockerA = fakeDocker('daemon-a')
  const dockerB = fakeDocker('daemon-b')
  try {
    const first = await acquire(stateDir, dockerA, '11111111111111111111111111111111')
    let sameDaemonAcquired = false
    const sameDaemon = acquire(stateDir, dockerA, '22222222222222222222222222222222').then((lease) => {
      sameDaemonAcquired = true
      return lease
    })
    await Bun.sleep(75)
    expect(sameDaemonAcquired).toBe(false)

    const otherScope = await acquire(stateDir, dockerA, '33333333333333333333333333333333', 'agent-b')
    const otherDaemon = await acquire(stateDir, dockerB, '44444444444444444444444444444444')
    await otherScope.finish(false)
    await otherDaemon.finish(false)
    await first.finish(false)
    const second = await sameDaemon
    await second.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('finish removes only the owned ephemeral builder under isolated BUILDX_CONFIG', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const lease = await acquire(stateDir, docker, '11111111111111111111111111111111')
    docker.calls.length = 0
    await lease.finish(false)

    const removal = docker.calls.find(({ args }) => args[0] === 'buildx' && args[1] === 'rm')
    expect(removal).toEqual({
      args: ['buildx', 'rm', lease.builder.builderName],
      env: lease.builder.env,
    })
    expect(docker.calls.some(({ args }) => args[0] === 'buildx' && args[1] === 'prune')).toBe(false)
    expect(docker.calls.some(({ args }) => args[0] === 'system' || args[0] === 'builder')).toBe(false)
    expect(docker.calls.some(({ args }) => args[0] === 'image' || args[0] === 'volume')).toBe(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('recreates the same persisted owned builder name after successful removal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await first.finish(false)
    docker.calls.length = 0

    const second = await acquire(stateDir, docker, '22222222222222222222222222222222')
    expect(second.builder.builderName).toBe(first.builder.builderName)
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'create')).toEqual([
      {
        args: ['buildx', 'create', '--driver', 'docker-container', '--name', first.builder.builderName],
        env: first.builder.env,
      },
    ])
    await second.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('failed ephemeral builder removal is retried after the next build attempt', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    docker.setBuilderRmFails(true)
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    expect((await first.finish(false)).warnings.join(' ')).toContain('builder removal failed')

    docker.setBuilderRmFails(false)
    docker.calls.length = 0
    const second = await acquire(stateDir, docker, '22222222222222222222222222222222')
    await second.finish(false)

    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'create')).toHaveLength(0)
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toEqual([
      { args: ['buildx', 'rm', first.builder.builderName], env: first.builder.env },
    ])
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('cleans retired daemon roots only inside the current cache scope', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker('daemon-old')
  try {
    const oldA = await acquire(stateDir, docker, '11111111111111111111111111111111', 'agent-a')
    await exported(oldA)
    await oldA.finish(true)
    const oldARoot = dirname(oldA.cacheRoot)

    const oldB = await acquire(stateDir, docker, '22222222222222222222222222222222', 'agent-b')
    await exported(oldB)
    await oldB.finish(true)
    const oldBRoot = dirname(oldB.cacheRoot)

    docker.setDaemonId('daemon-new')
    const current = await acquire(stateDir, docker, '33333333333333333333333333333333', 'agent-a')

    expect(existsSync(oldARoot)).toBe(false)
    expect(existsSync(oldBRoot)).toBe(true)
    await current.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('removes a proven owned builder before deleting its retired daemon root', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker('daemon-old')
  try {
    docker.setBuilderRmFails(true)
    const old = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await old.finish(false)
    const oldRoot = dirname(old.cacheRoot)

    docker.setBuilderRmFails(false)
    docker.setDaemonId('daemon-new')
    docker.calls.length = 0
    const current = await acquire(stateDir, docker, '22222222222222222222222222222222')

    expect(docker.calls.some(({ args }) => args.join(' ') === `buildx rm ${old.builder.builderName}`)).toBe(true)
    expect(existsSync(oldRoot)).toBe(false)
    await current.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('corrupt cache state returns the exact safe reset path instead of silently disabling cache', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)
    const daemonRoot = dirname(first.cacheRoot)
    await writeFile(join(first.cacheRoot, 'active.json'), '{broken')
    docker.calls.length = 0

    const result = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => first.builder.builderName,
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain(`Remove ${daemonRoot} and retry`)
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toHaveLength(1)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('generation prune failure keeps the promoted pointer and leaves the spare for a later acquire', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)
    const activePath = join(first.cacheRoot, 'active.json')
    const oldPointer = await readFile(activePath, 'utf8')

    const acquired = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => first.builder.builderName,
      randomGenerationId: () => '22222222222222222222222222222222',
      faultInjection: {
        removeGeneration: async () => {
          throw new Error('injected generation deletion failure')
        },
      },
    })
    if (!acquired.ok) throw new Error(acquired.reason)
    await exported(acquired.lease)
    docker.calls.length = 0
    const result = await acquired.lease.finish(true)

    expect(result.warnings.join(' ')).toContain('injected generation deletion failure')
    expect(await readFile(activePath, 'utf8')).not.toBe(oldPointer)
    expect(JSON.parse(await readFile(activePath, 'utf8'))).toEqual({
      version: 1,
      generationId: '22222222222222222222222222222222',
    })
    expect(existsSync(acquired.lease.stagingPath)).toBe(true)
    expect((await readdir(join(first.cacheRoot, 'generations'))).sort()).toEqual([
      '11111111111111111111111111111111',
      '22222222222222222222222222222222',
    ])
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toHaveLength(1)

    const next = await acquire(stateDir, docker, '33333333333333333333333333333333')
    expect(await readdir(join(first.cacheRoot, 'generations'))).toEqual(['22222222222222222222222222222222'])
    await next.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('active-pointer write failure removes staging, keeps the prior generation, and still removes the builder', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)
    const activePath = join(first.cacheRoot, 'active.json')
    const oldPointer = await readFile(activePath, 'utf8')

    const acquired = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => first.builder.builderName,
      randomGenerationId: () => '22222222222222222222222222222222',
      faultInjection: {
        beforeActivePersist: () => {
          throw new Error('injected active pointer failure')
        },
      },
    })
    if (!acquired.ok) throw new Error(acquired.reason)
    await exported(acquired.lease)
    docker.calls.length = 0
    const result = await acquired.lease.finish(true)

    expect(result.warnings.join(' ')).toContain('injected active pointer failure')
    expect(await readFile(activePath, 'utf8')).toBe(oldPointer)
    expect(existsSync(acquired.lease.stagingPath)).toBe(false)
    expect(await readdir(join(first.cacheRoot, 'generations'))).toEqual(['11111111111111111111111111111111'])
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toHaveLength(1)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('retired cache cleanup unlinks a deep symlink without inspecting or touching its target', async () => {
  if (process.platform === 'win32') return
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const external = await mkdtemp(join(tmpdir(), 'typeclaw-external-cache-target-'))
  const docker = fakeDocker('daemon-old')
  try {
    const old = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(old)
    await old.finish(true)
    const target = join(external, 'keep.txt')
    await writeFile(target, 'keep')
    await symlink(external, join(old.stagingPath, 'deep-link'))
    const oldRoot = dirname(old.cacheRoot)

    docker.setDaemonId('daemon-new')
    const current = await acquire(stateDir, docker, '22222222222222222222222222222222')

    expect(existsSync(oldRoot)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('keep')
    await current.finish(false)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('acquire folds lock release failure into a fail-open result after removing its builder', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const result = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa',
      randomGenerationId: () => 'invalid',
      faultInjection: {
        releaseLock: async (release) => {
          await release()
          throw new Error('injected release failure')
        },
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('injected release failure')
    expect(docker.calls.filter(({ args }) => args[0] === 'buildx' && args[1] === 'rm')).toHaveLength(1)
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('acquire failure names builder-first recovery when owned builder removal also fails', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    docker.setBuilderRmFails(true)
    const result = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir,
      cacheScope: 'agent-a',
      randomBuilderName: () => 'typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa',
      randomGenerationId: () => 'invalid',
    })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('Remove builder typeclaw-aaaaaaaaaaaaaaaaaaaaaaaa first')
    expect(result.reason).toContain('BUILDX_CONFIG=')
    expect(result.reason).toContain('then remove')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('missing cache export warns and retains the previous active generation without failing the build', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-'))
  const docker = fakeDocker()
  try {
    const first = await acquire(stateDir, docker, '11111111111111111111111111111111')
    await exported(first)
    await first.finish(true)

    const second = await acquire(stateDir, docker, '22222222222222222222222222222222')
    const result = await second.finish(true)

    expect(result.warnings.join(' ')).toContain('did not export the expected local cache')
    expect(await onlyGeneration(second)).toBe('11111111111111111111111111111111')
  } finally {
    await rm(stateDir, { recursive: true, force: true })
  }
})

test('hardens private paths and rejects BuildKit CSV-unsafe cache paths', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-build-cache-path-'))
  const target = join(root, 'target')
  const linked = join(root, 'linked')
  await mkdir(target)
  await symlink(target, linked)
  const docker = fakeDocker()
  try {
    const linkedResult = await acquireManagedBuildCache({ exec: docker.exec, stateDir: linked, cacheScope: 'agent-a' })
    expect(linkedResult.ok).toBe(false)
    if (linkedResult.ok) throw new Error('unreachable')
    expect(linkedResult.reason).toContain('not a directory')

    await chmod(target, 0o755)
    const tightened = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir: target,
      cacheScope: 'agent-a',
      randomBuilderName: () => 'invalid',
    })
    expect(tightened.ok).toBe(false)
    expect((await stat(target)).mode & 0o777).toBe(0o700)

    const comma = await acquireManagedBuildCache({
      exec: docker.exec,
      stateDir: join(root, 'with,comma'),
      cacheScope: 'agent-a',
    })
    expect(comma).toEqual({ ok: false, reason: 'managed local cache path cannot contain a comma' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
