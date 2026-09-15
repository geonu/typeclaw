import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import lockfile from 'proper-lockfile'

import { buildCacheDir } from '@/hostd/paths'

import { sanitizeDockerStderr, type DockerExec } from './shared'

const STATE_VERSION = 1
const ACTIVE_VERSION = 1
const BUILDER_NAME = /^typeclaw-[a-f0-9]{24}$/
const GENERATION_ID = /^[a-f0-9]{32}$/
const HASH_DIRECTORY = /^[a-f0-9]{64}$/

type BuilderState = {
  version: typeof STATE_VERSION
  daemonId: string
  builderName: string
  status: 'reserved' | 'ready'
}

type ActiveCache = {
  version: typeof ACTIVE_VERSION
  generationId: string
}

export type ManagedBuildxBuilder = {
  builderName: string
  daemonId: string
  statePath: string
  env: { BUILDX_CONFIG: string }
}

export type ManagedBuildCacheLease = {
  builder: ManagedBuildxBuilder
  cacheRoot: string
  stagingPath: string
  cacheArgs: string[]
  finish: (success: boolean) => Promise<{ warnings: string[] }>
}

export type ManagedBuildCacheResult =
  | { ok: true; lease: ManagedBuildCacheLease; warnings: string[] }
  | { ok: false; reason: string }

export async function acquireManagedBuildCache(options: {
  exec: DockerExec
  cacheScope: string
  stateDir?: string
  randomBuilderName?: () => string
  randomGenerationId?: () => string
  faultInjection?: {
    removeGeneration?: (path: string) => Promise<void>
    beforeActivePersist?: () => void | Promise<void>
    beforeReadyPersist?: () => void | Promise<void>
    releaseLock?: (release: () => Promise<void>) => Promise<void>
  }
}): Promise<ManagedBuildCacheResult> {
  const daemon = await queryDaemonId(options.exec)
  if (!daemon.ok) return daemon

  const stateDir = options.stateDir ?? buildCacheDir()
  const scopeKey = createHash('sha256').update(options.cacheScope).digest('hex')
  const daemonKey = createHash('sha256').update(daemon.daemonId).digest('hex')
  const scopePath = join(stateDir, scopeKey)
  const daemonStatePath = join(scopePath, daemonKey)
  const builderStatePath = join(daemonStatePath, 'builder.json')
  const cacheRoot = join(daemonStatePath, 'local-cache')
  const generationsPath = join(cacheRoot, 'generations')
  const activePath = join(cacheRoot, 'active.json')
  const lockPath = join(daemonStatePath, 'lease.lock')
  const builderBase = {
    daemonId: daemon.daemonId,
    statePath: builderStatePath,
    env: { BUILDX_CONFIG: join(daemonStatePath, 'buildx') },
  }
  if (cacheRoot.includes(',')) return { ok: false, reason: 'managed local cache path cannot contain a comma' }

  const randomBuilderName = options.randomBuilderName ?? (() => `typeclaw-${randomBytes(12).toString('hex')}`)
  const randomGenerationId = options.randomGenerationId ?? (() => randomBytes(16).toString('hex'))
  let release: (() => Promise<void>) | null = null
  let preparedBuilder: ManagedBuildxBuilder | null = null
  let compromised: Error | null = null
  const assertLock = (): void => {
    if (compromised !== null) throw compromised
  }
  const failAcquire = async (reason: string): Promise<ManagedBuildCacheResult> => {
    let combined = reason
    if (preparedBuilder !== null) {
      const cleanupFailure = await removeExplicitOwnedBuilder(options.exec, preparedBuilder)
      if (cleanupFailure !== null) {
        combined = `${combined} ${builderFirstRecovery(preparedBuilder, daemonStatePath, cleanupFailure)}`
      }
    }
    try {
      if (release !== null) {
        if (options.faultInjection?.releaseLock !== undefined) {
          await options.faultInjection.releaseLock(release)
        } else {
          await releaseLock(release)
        }
      }
    } catch (error) {
      combined = `${combined} Managed build cache lock release failed: ${describeError(error)}`
    }
    release = null
    return { ok: false, reason: combined }
  }

  try {
    await ensurePrivateDirectory(stateDir)
    await ensurePrivateDirectory(scopePath)
    const warnings = await cleanupRetiredDaemonRoots(options.exec, scopePath, daemonKey)
    await ensurePrivateDirectory(daemonStatePath)
    await ensurePrivateDirectory(builderBase.env.BUILDX_CONFIG)
    await ensurePrivateDirectory(cacheRoot)
    await ensurePrivateDirectory(generationsPath)
    await rejectSymlink(lockPath)
    release = await lockfile.lock(builderStatePath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: { retries: 2_400, factor: 1, minTimeout: 50, maxTimeout: 50, randomize: false },
      onCompromised: (error) => {
        compromised = error
      },
    })

    const prepared = await prepareLocked(
      options.exec,
      builderBase,
      randomBuilderName,
      assertLock,
      options.faultInjection?.beforeReadyPersist,
    )
    assertLock()
    if (!prepared.ok) {
      return await failAcquire(
        isOwnershipStateReason(prepared.reason) ? recoveryReason(prepared.reason, daemonStatePath) : prepared.reason,
      )
    }
    preparedBuilder = prepared.builder

    const active = await readActiveCache(activePath, generationsPath)
    if (!active.ok) {
      return await failAcquire(recoveryReason(active.reason, daemonStatePath))
    }
    assertLock()
    try {
      await removeInactiveGenerations(generationsPath, active.generationId, assertLock)
    } catch (error) {
      return await failAcquire(recoveryReason(describeError(error), daemonStatePath))
    }

    const generationId = await reserveGenerationId(generationsPath, randomGenerationId)
    if (!generationId.ok) {
      return await failAcquire(generationId.reason)
    }
    const stagingPath = join(generationsPath, generationId.generationId)
    const cacheArgs = [
      ...(active.generationId === null
        ? []
        : ['--cache-from', `type=local,src=${join(generationsPath, active.generationId)}`]),
      '--cache-to',
      `type=local,dest=${stagingPath},mode=min`,
    ]
    let finished = false
    const heldRelease = release
    release = null

    return {
      ok: true,
      warnings,
      lease: {
        builder: prepared.builder,
        cacheRoot,
        stagingPath,
        cacheArgs,
        finish: async (success) => {
          if (finished) return { warnings: ['managed build cache lease was already finished'] }
          finished = true
          return await finishLease({
            exec: options.exec,
            builder: prepared.builder,
            generationsPath,
            activePath,
            generationId: generationId.generationId,
            stagingPath,
            success,
            assertLock,
            release: heldRelease,
            ...(options.faultInjection?.removeGeneration !== undefined
              ? { removeGeneration: options.faultInjection.removeGeneration }
              : {}),
            ...(options.faultInjection?.beforeActivePersist !== undefined
              ? { beforeActivePersist: options.faultInjection.beforeActivePersist }
              : {}),
          })
        },
      },
    }
  } catch (error) {
    return await failAcquire(describeError(error))
  }
}

async function cleanupRetiredDaemonRoots(
  exec: DockerExec,
  scopePath: string,
  currentDaemonKey: string,
): Promise<string[]> {
  const warnings: string[] = []
  for (const entry of await readdir(scopePath, { withFileTypes: true })) {
    if (entry.name === currentDaemonKey) continue
    const retiredPath = join(scopePath, entry.name)
    if (!isHashDirectory(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      warnings.push(`unsafe managed build cache entry preserved at ${retiredPath}; inspect and remove it manually`)
      continue
    }
    warnings.push(...(await cleanupRetiredDaemonRoot(exec, retiredPath, entry.name)))
  }
  return warnings
}

async function cleanupRetiredDaemonRoot(exec: DockerExec, retiredPath: string, daemonKey: string): Promise<string[]> {
  const warnings: string[] = []
  const statePath = join(retiredPath, 'builder.json')
  const buildxConfig = join(retiredPath, 'buildx')
  const cacheRoot = join(retiredPath, 'local-cache')
  const lockPath = join(retiredPath, 'lease.lock')
  let release: (() => Promise<void>) | null = null
  let compromised: Error | null = null
  try {
    if ((await inspectDirectory(retiredPath)) !== 'directory') {
      return [`unsafe retired managed build cache preserved at ${retiredPath}; inspect and remove it manually`]
    }
    await rejectSymlink(lockPath)
    release = await lockfile.lock(statePath, {
      lockfilePath: lockPath,
      realpath: false,
      stale: 30_000,
      retries: 0,
      onCompromised: (error) => {
        compromised = error
      },
    })
    const assertLock = (): void => {
      if (compromised !== null) throw compromised
    }
    assertLock()

    const allowedEntries = new Set(['builder.json', 'buildx', 'local-cache', 'lease.lock'])
    const entries = await readdir(retiredPath, { withFileTypes: true })
    const unknown = entries.find((entry) => !allowedEntries.has(entry.name))
    if (unknown !== undefined) {
      return [
        `unknown retired managed build cache entry preserved at ${join(retiredPath, unknown.name)}; inspect it manually`,
      ]
    }

    const stored = await readOwnedState(statePath)
    if (
      !stored.ok ||
      stored.state === null ||
      createHash('sha256').update(stored.state.daemonId).digest('hex') !== daemonKey
    ) {
      return [
        `retired managed build cache ownership could not be proven at ${retiredPath}; remove ${retiredPath} manually after inspection`,
      ]
    }
    if ((await inspectDirectory(buildxConfig)) !== 'directory') {
      return [
        `retired managed buildx config is unsafe at ${buildxConfig}; remove ${retiredPath} manually after inspection`,
      ]
    }
    if ((await inspectDirectory(cacheRoot)) !== 'directory') {
      return [`retired managed local cache is unsafe at ${cacheRoot}; remove ${retiredPath} manually after inspection`]
    }
    await validatePrivateTree(buildxConfig)
    assertLock()

    const env = { BUILDX_CONFIG: buildxConfig }
    const inspected = await exec(['buildx', 'inspect', stored.state.builderName], { env })
    assertLock()
    if (inspected.exitCode === 0) {
      const removed = await exec(['buildx', 'rm', stored.state.builderName], { env })
      assertLock()
      if (removed.exitCode !== 0) {
        return [
          `retired managed builder removal failed for ${stored.state.builderName}; preserving ${retiredPath}: ${sanitizeDockerStderr(removed.stderr) || `docker buildx rm exited ${removed.exitCode}`}`,
        ]
      }
    } else if (!isMissingBuildxBuilder(inspected.stderr)) {
      return [
        `retired managed builder could not be inspected; preserving ${retiredPath}: ${sanitizeDockerStderr(inspected.stderr) || `docker buildx inspect exited ${inspected.exitCode}`}`,
      ]
    }

    await rm(cacheRoot, { recursive: true, force: true })
    await rm(buildxConfig, { recursive: true, force: true })
    await rm(statePath, { force: true })
    assertLock()
  } catch (error) {
    if (errorCode(error) === 'ELOCKED') {
      warnings.push(`retired managed build cache is in use and was preserved at ${retiredPath}`)
    } else {
      warnings.push(`retired managed build cache was preserved at ${retiredPath}: ${describeError(error)}`)
    }
  } finally {
    try {
      await releaseLock(release)
    } catch (error) {
      warnings.push(`retired managed build cache lock release failed at ${retiredPath}: ${describeError(error)}`)
    }
  }

  if (warnings.length === 0) {
    try {
      await rmdir(retiredPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        warnings.push(
          `retired managed build cache root could not be removed at ${retiredPath}: ${describeError(error)}`,
        )
      }
    }
  }
  return warnings
}

async function finishLease(options: {
  exec: DockerExec
  builder: ManagedBuildxBuilder
  generationsPath: string
  activePath: string
  generationId: string
  stagingPath: string
  success: boolean
  assertLock: () => void
  release: () => Promise<void>
  removeGeneration?: (path: string) => Promise<void>
  beforeActivePersist?: () => void | Promise<void>
}): Promise<{ warnings: string[] }> {
  const warnings: string[] = []
  try {
    options.assertLock()
    const ownership = await validateOwnership(options.exec, options.builder)
    options.assertLock()
    if (!ownership.ok) {
      warnings.push(ownership.reason)
      await removeStaging(options.stagingPath, warnings)
    } else {
      try {
        if (options.success) await promoteSuccessfulCache(options, warnings)
        else await removeStaging(options.stagingPath, warnings)
      } catch (error) {
        warnings.push(`managed build cache rotation failed: ${describeError(error)}`)
        await removeStaging(options.stagingPath, warnings)
      } finally {
        try {
          options.assertLock()
          const cleanupFailure = await removeExplicitOwnedBuilder(options.exec, options.builder)
          options.assertLock()
          if (cleanupFailure !== null) {
            warnings.push(`managed builder removal failed for ${options.builder.builderName}: ${cleanupFailure}`)
          }
        } catch (error) {
          warnings.push(`managed builder removal refused for ${options.builder.builderName}: ${describeError(error)}`)
        }
      }
    }
  } catch (error) {
    warnings.push(`managed build cache rotation/builder removal refused: ${describeError(error)}`)
  } finally {
    try {
      await options.release()
    } catch (error) {
      warnings.push(`managed build cache lock release failed: ${describeError(error)}`)
    }
  }
  return { warnings }
}

async function promoteSuccessfulCache(
  options: {
    generationsPath: string
    activePath: string
    generationId: string
    stagingPath: string
    assertLock: () => void
    removeGeneration?: (path: string) => Promise<void>
    beforeActivePersist?: () => void | Promise<void>
  },
  warnings: string[],
): Promise<void> {
  const staging = await inspectDirectory(options.stagingPath)
  options.assertLock()
  if (staging === 'missing') {
    warnings.push('managed build succeeded but did not export the expected local cache; retaining the previous cache')
    return
  }
  if (staging !== 'directory') {
    warnings.push('managed build cache export path is not a private directory; retaining the previous cache')
    return
  }

  // Publish the pointer before pruning: a prune failure only leaves a spare
  // generation for the next acquire to collect, while pruning first would strand
  // the old pointer on a deleted directory if this write fails.
  try {
    await options.beforeActivePersist?.()
    options.assertLock()
    await persistJson(options.activePath, {
      version: ACTIVE_VERSION,
      generationId: options.generationId,
    })
    options.assertLock()
  } catch (error) {
    warnings.push(`managed build cache pointer promotion failed: ${describeError(error)}`)
    await removeStaging(options.stagingPath, warnings)
    return
  }

  try {
    await removeInactiveGenerations(
      options.generationsPath,
      options.generationId,
      options.assertLock,
      options.removeGeneration,
    )
  } catch (error) {
    warnings.push(`managed build cache generation cleanup failed: ${describeError(error)}`)
  }
}

async function validateOwnership(
  exec: DockerExec,
  builder: ManagedBuildxBuilder,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!BUILDER_NAME.test(builder.builderName)) {
    return { ok: false, reason: 'refusing managed cache rotation/builder removal for a non-TypeClaw builder name' }
  }
  const daemon = await queryDaemonId(exec)
  if (!daemon.ok || daemon.daemonId !== builder.daemonId) {
    return { ok: false, reason: 'refusing managed cache rotation/builder removal after Docker daemon identity changed' }
  }
  const ownership = await readState(builder.statePath, builder.daemonId)
  if (!ownership.ok || ownership.state?.status !== 'ready' || ownership.state.builderName !== builder.builderName) {
    return {
      ok: false,
      reason: 'refusing managed cache rotation/builder removal without matching daemon-scoped ownership state',
    }
  }
  const inspected = await exec(['buildx', 'inspect', builder.builderName], { env: builder.env })
  if (inspected.exitCode !== 0) {
    return { ok: false, reason: 'refusing managed cache rotation/builder removal for a missing managed builder' }
  }
  return { ok: true }
}

async function queryDaemonId(
  exec: DockerExec,
): Promise<{ ok: true; daemonId: string } | { ok: false; reason: string }> {
  try {
    const result = await exec(['info', '--format', '{{.ID}}'])
    const daemonId = result.stdout.trim()
    if (result.exitCode !== 0 || daemonId.length === 0) {
      return { ok: false, reason: sanitizeDockerStderr(result.stderr) || 'docker info returned no daemon ID' }
    }
    return { ok: true, daemonId }
  } catch (error) {
    return { ok: false, reason: describeError(error) }
  }
}

async function prepareLocked(
  exec: DockerExec,
  builder: Omit<ManagedBuildxBuilder, 'builderName'>,
  randomName: () => string,
  assertLock: () => void,
  beforeReadyPersist?: () => void | Promise<void>,
): Promise<{ ok: true; builder: ManagedBuildxBuilder } | { ok: false; reason: string }> {
  assertLock()
  const stored = await readState(builder.statePath, builder.daemonId)
  if (!stored.ok) return stored

  if (stored.state?.status === 'ready') {
    const inspected = await exec(['buildx', 'inspect', stored.state.builderName], { env: builder.env })
    assertLock()
    if (inspected.exitCode === 0) return { ok: true, builder: { ...builder, builderName: stored.state.builderName } }
    return await createOwnedBuilder(exec, builder, stored.state, assertLock, beforeReadyPersist)
  }

  if (stored.state?.status === 'reserved') {
    const inspected = await exec(['buildx', 'inspect', stored.state.builderName], { env: builder.env })
    assertLock()
    if (inspected.exitCode !== 0)
      return await createOwnedBuilder(exec, builder, stored.state, assertLock, beforeReadyPersist)
    await persistJson(builder.statePath, { ...stored.state, status: 'ready' })
    assertLock()
    return { ok: true, builder: { ...builder, builderName: stored.state.builderName } }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const builderName = randomName()
    if (builderName.length !== 33 || !BUILDER_NAME.test(builderName)) {
      return { ok: false, reason: 'generated an invalid managed builder name' }
    }
    const inspected = await exec(['buildx', 'inspect', builderName], { env: builder.env })
    assertLock()
    if (inspected.exitCode === 0) continue
    const reserved: BuilderState = {
      version: STATE_VERSION,
      daemonId: builder.daemonId,
      builderName,
      status: 'reserved',
    }
    await persistJson(builder.statePath, reserved)
    assertLock()
    return await createOwnedBuilder(exec, builder, reserved, assertLock, beforeReadyPersist)
  }
  return { ok: false, reason: 'could not allocate a collision-free managed builder name' }
}

async function createOwnedBuilder(
  exec: DockerExec,
  builder: Omit<ManagedBuildxBuilder, 'builderName'>,
  reserved: BuilderState,
  assertLock: () => void,
  beforeReadyPersist?: () => void | Promise<void>,
): Promise<{ ok: true; builder: ManagedBuildxBuilder } | { ok: false; reason: string }> {
  const created = await exec(['buildx', 'create', '--driver', 'docker-container', '--name', reserved.builderName], {
    env: builder.env,
  })
  if (created.exitCode !== 0) {
    assertLock()
    return {
      ok: false,
      reason: sanitizeDockerStderr(created.stderr) || `docker buildx create exited ${created.exitCode}`,
    }
  }
  const ownedBuilder = { ...builder, builderName: reserved.builderName }
  try {
    assertLock()
    await beforeReadyPersist?.()
    await persistJson(builder.statePath, { ...reserved, status: 'ready' })
    assertLock()
    return { ok: true, builder: ownedBuilder }
  } catch (error) {
    const reason = `managed builder ready-state persistence failed: ${describeError(error)}`
    const cleanupFailure = await removeExplicitOwnedBuilder(exec, ownedBuilder)
    return {
      ok: false,
      reason:
        cleanupFailure === null
          ? reason
          : `${reason} ${builderFirstRecovery(ownedBuilder, dirname(builder.statePath), cleanupFailure)}`,
    }
  }
}

async function readState(
  path: string,
  daemonId: string,
): Promise<{ ok: true; state: BuilderState | null } | { ok: false; reason: string }> {
  const file = await readRegularFile(path, 'managed builder ownership state')
  if (!file.ok || file.raw === null) return file.ok ? { ok: true, state: null } : file
  try {
    const value: unknown = JSON.parse(file.raw)
    if (!isBuilderState(value) || value.daemonId !== daemonId) {
      return { ok: false, reason: 'managed builder ownership state is invalid' }
    }
    return { ok: true, state: value }
  } catch (error) {
    return { ok: false, reason: `managed builder ownership state is invalid: ${describeError(error)}` }
  }
}

async function readOwnedState(
  path: string,
): Promise<{ ok: true; state: BuilderState | null } | { ok: false; reason: string }> {
  const file = await readRegularFile(path, 'managed builder ownership state')
  if (!file.ok || file.raw === null) return file.ok ? { ok: true, state: null } : file
  try {
    const value: unknown = JSON.parse(file.raw)
    return isBuilderState(value)
      ? { ok: true, state: value }
      : { ok: false, reason: 'managed builder ownership state is invalid' }
  } catch (error) {
    return { ok: false, reason: `managed builder ownership state is invalid: ${describeError(error)}` }
  }
}

async function readActiveCache(
  activePath: string,
  generationsPath: string,
): Promise<{ ok: true; generationId: string | null } | { ok: false; reason: string }> {
  const file = await readRegularFile(activePath, 'managed cache active pointer')
  if (!file.ok || file.raw === null) return file.ok ? { ok: true, generationId: null } : file
  try {
    const value: unknown = JSON.parse(file.raw)
    if (!isActiveCache(value)) return { ok: false, reason: 'managed cache active pointer is invalid' }
    const kind = await inspectDirectory(join(generationsPath, value.generationId))
    if (kind === 'missing') {
      await rm(activePath, { force: true })
      return { ok: true, generationId: null }
    }
    if (kind !== 'directory') return { ok: false, reason: 'managed cache active generation is not a private directory' }
    return { ok: true, generationId: value.generationId }
  } catch (error) {
    return { ok: false, reason: `managed cache active pointer is invalid: ${describeError(error)}` }
  }
}

async function readRegularFile(
  path: string,
  label: string,
): Promise<{ ok: true; raw: string | null } | { ok: false; reason: string }> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile()) return { ok: false, reason: `${label} is not a regular file` }
    return { ok: true, raw: await readFile(path, 'utf8') }
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: true, raw: null }
    return { ok: false, reason: describeError(error) }
  }
}

async function reserveGenerationId(
  generationsPath: string,
  randomGenerationId: () => string,
): Promise<{ ok: true; generationId: string } | { ok: false; reason: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const generationId = randomGenerationId()
    if (generationId.length !== 32 || !GENERATION_ID.test(generationId)) {
      return { ok: false, reason: 'generated an invalid managed cache generation ID' }
    }
    if ((await inspectDirectory(join(generationsPath, generationId))) === 'missing') {
      return { ok: true, generationId }
    }
  }
  return { ok: false, reason: 'could not allocate a collision-free managed cache generation ID' }
}

async function removeInactiveGenerations(
  generationsPath: string,
  retainedGenerationId: string | null,
  assertLock: () => void,
  removeGeneration: (path: string) => Promise<void> = async (path) => await rm(path, { recursive: true, force: true }),
): Promise<void> {
  for (const entry of await readdir(generationsPath, { withFileTypes: true })) {
    assertLock()
    if (!GENERATION_ID.test(entry.name))
      throw new Error(`managed cache contains an invalid generation name: ${entry.name}`)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`managed cache generation is not a directory: ${entry.name}`)
    }
    if (entry.name !== retainedGenerationId) await removeGeneration(join(generationsPath, entry.name))
  }
}

async function removeStaging(path: string, warnings: string[]): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    warnings.push(`managed build cache staging cleanup failed: ${describeError(error)}`)
  }
}

async function inspectDirectory(path: string): Promise<'directory' | 'missing' | 'unsafe'> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) return 'unsafe'
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (uid !== undefined && info.uid !== uid) return 'unsafe'
    await chmod(path, 0o700)
    return 'directory'
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

async function validatePrivateTree(path: string): Promise<void> {
  const info = await lstat(path)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (info.isSymbolicLink() || (uid !== undefined && info.uid !== uid)) {
    throw new Error(`managed build cache tree contains an unsafe path: ${path}`)
  }
  if (!info.isDirectory()) return
  await chmod(path, 0o700)
  for (const entry of await readdir(path)) await validatePrivateTree(join(path, entry))
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`managed build cache path is not a directory: ${path}`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`managed build cache path is not owned by the current user: ${path}`)
  }
  await chmod(path, 0o700)
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`managed build cache lock path is a symlink: ${path}`)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function isBuilderState(value: unknown): value is BuilderState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === STATE_VERSION &&
    typeof record.daemonId === 'string' &&
    typeof record.builderName === 'string' &&
    record.builderName.length === 33 &&
    BUILDER_NAME.test(record.builderName) &&
    (record.status === 'reserved' || record.status === 'ready')
  )
}

function isActiveCache(value: unknown): value is ActiveCache {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === ACTIVE_VERSION &&
    typeof record.generationId === 'string' &&
    record.generationId.length === 32 &&
    GENERATION_ID.test(record.generationId)
  )
}

function isHashDirectory(value: string): boolean {
  return value.length === 64 && HASH_DIRECTORY.test(value)
}

function isOwnershipStateReason(reason: string): boolean {
  return reason.startsWith('managed builder ownership state')
}

function recoveryReason(reason: string, resetPath: string): string {
  return `${reason}. Remove ${resetPath} and retry.`
}

async function removeExplicitOwnedBuilder(exec: DockerExec, builder: ManagedBuildxBuilder): Promise<string | null> {
  try {
    const result = await exec(['buildx', 'rm', builder.builderName], { env: builder.env })
    return result.exitCode === 0
      ? null
      : sanitizeDockerStderr(result.stderr) || `docker buildx rm exited ${result.exitCode}`
  } catch (error) {
    return describeError(error)
  }
}

function builderFirstRecovery(builder: ManagedBuildxBuilder, statePath: string, failure: string): string {
  return (
    `Owned builder cleanup failed: ${failure}. Remove builder ${builder.builderName} first with ` +
    `\`BUILDX_CONFIG="${builder.env.BUILDX_CONFIG}" docker buildx rm ${builder.builderName}\`, ` +
    `then remove ${statePath} and retry.`
  )
}

function isMissingBuildxBuilder(stderr: string): boolean {
  return /(?:no builder|not found|does not exist)/i.test(stderr)
}

async function persistJson(path: string, value: BuilderState | ActiveCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  }
}

async function releaseLock(release: (() => Promise<void>) | null): Promise<void> {
  if (release === null) return
  try {
    await release()
  } catch (error) {
    if (errorCode(error) !== 'ERELEASED') throw error
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
