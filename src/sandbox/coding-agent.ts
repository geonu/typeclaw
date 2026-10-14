import { lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { createAndOpenAnchoredDirectory } from '@/agent/tool-file-safety'
import { config } from '@/config/config'

import { canMountRealProc, ensureBwrapAvailable, getProcBindSafetyVerdict } from './availability'
import { buildSandboxedCommand, type SandboxedCommand } from './build'
import {
  CANONICAL_AGENT_SECRET_DIRS,
  CANONICAL_AGENT_SECRET_FILES,
  CANONICAL_HOME_SECRET_DIRS,
  CANONICAL_HOME_SECRET_FILES,
} from './canonical-secrets'
import { verifyHiddenMaskTargets } from './hidden-paths'
import type { SandboxPolicy, SandboxProcStrategy } from './policy'
import { formatCommand } from './quote'
import { CANONICAL_AGENT_RUNTIME_PRIVATE_FILES } from './runtime-private'

export const CODING_SOURCE = '/typeclaw-coding-source'
export const CODING_MASK_DIRS = [
  ...CANONICAL_AGENT_SECRET_DIRS,
  // Repository-scoped Claude/Codex settings are executable project context,
  // not the runtime HOME profiles (HOME is never mounted). Mask their auth files.
  ...CANONICAL_HOME_SECRET_DIRS.filter((dir) => dir !== '.claude' && dir !== '.codex'),
  '.typeclaw',
] as const
export const CODING_MASK_FILES = [
  ...CANONICAL_AGENT_SECRET_FILES,
  ...CANONICAL_HOME_SECRET_FILES,
  ...CANONICAL_AGENT_RUNTIME_PRIVATE_FILES,
  '.claude/.credentials.json',
  '.codex/auth.json',
] as const

export function codingSourceMaskDirs(source: string, taskRoot: string): readonly string[] {
  return source === resolve(taskRoot, '../../..')
    ? [...CODING_MASK_DIRS, 'workspace', 'sessions', 'memory']
    : CODING_MASK_DIRS
}

export type CodingSandboxOptions = {
  readonly source: string
  readonly taskRoot: string
  readonly mode: 'code' | 'plan'
  readonly cwd: string
  readonly env?: Record<string, string>
}

export async function assertCodingDirectory(path: string): Promise<void> {
  const absolute = resolve(path)
  if ((await realpath(absolute)) !== absolute || !(await lstat(absolute)).isDirectory()) {
    throw new Error('Coding task directory is a symlink or changed identity.')
  }
}

export async function codingSandboxPolicy(
  options: CodingSandboxOptions,
  proc: SandboxProcStrategy,
): Promise<SandboxPolicy> {
  await assertCodingDirectory(options.source)
  await assertCodingDirectory(options.taskRoot)
  const dirs: string[] = []
  const files: string[] = []
  for (const name of new Set([...codingSourceMaskDirs(options.source, options.taskRoot), ...CODING_MASK_FILES])) {
    const stat = await lstat(join(options.source, name)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    if (!stat) continue
    // Never follow a masked alias during mount setup.
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) {
      throw new Error('Source has an unsafe canonical mask target.')
    }
    if (stat.isDirectory()) dirs.push(join(CODING_SOURCE, name))
    else files.push(join(CODING_SOURCE, name))
  }
  await verifyHiddenMaskTargets({
    dirs: dirs.map((path) => join(options.source, path.slice(CODING_SOURCE.length))),
    files: files.map((path) => join(options.source, path.slice(CODING_SOURCE.length))),
  })
  return {
    cwd: options.cwd,
    proc,
    network: 'inherit',
    env: { set: options.env ?? {} },
    mounts: [
      { type: 'ro-bind', source: options.source, dest: CODING_SOURCE },
      { type: 'bind', source: options.taskRoot, dest: options.taskRoot },
      ...(options.mode === 'plan'
        ? [
            { type: 'ro-bind' as const, source: join(options.taskRoot, 'git'), dest: join(options.taskRoot, 'git') },
            {
              type: 'ro-bind' as const,
              source: join(options.taskRoot, 'worktree'),
              dest: join(options.taskRoot, 'worktree'),
            },
          ]
        : []),
    ],
    masks: { dirs, files },
  }
}

export async function prepareCodingCommand(
  argv: readonly string[],
  options: CodingSandboxOptions,
): Promise<SandboxedCommand & { extraFiles: Array<number | 'ignore'>; cleanup(): Promise<void> }> {
  await ensureBwrapAvailable()
  const proc =
    config.sandbox.realProc && (await canMountRealProc())
      ? 'real-proc'
      : (await getProcBindSafetyVerdict()) === 'safe'
        ? 'proc-bind'
        : undefined
  if (!proc)
    throw new Error(
      'Coding delegation requires a verified safe /proc sandbox. Fix the container user-namespace policy and retry.',
    )
  const policy = await codingSandboxPolicy(options, proc)
  const capability = options.env?.ANTHROPIC_AUTH_TOKEN
  if (capability) {
    const { ANTHROPIC_AUTH_TOKEN: _capability, ...settings } = options.env
    policy.env = { set: settings, inherit: ['ANTHROPIC_AUTH_TOKEN'] }
  }
  const opened: Awaited<ReturnType<typeof createAndOpenAnchoredDirectory>>[] = []
  const extraFiles: Array<number | 'ignore'> = (policy.masks?.files ?? []).map(() => 'ignore')
  try {
    // Bind through explicitly inherited non-secret directory descriptors. A
    // sibling process swapping a pathname cannot redirect a mount after approval.
    for (const mount of policy.mounts ?? []) {
      if (mount.type !== 'bind' && mount.type !== 'ro-bind') continue
      const file = await createAndOpenAnchoredDirectory(mount.source, false)
      opened.push(file)
      mount.source = `/proc/self/fd/${3 + extraFiles.length}`
      extraFiles.push(file.fd)
    }
    const built = buildSandboxedCommand(`exec ${formatCommand([...argv])}`, policy)
    return {
      ...built,
      spawnEnv: { ...built.spawnEnv, ...(capability ? { ANTHROPIC_AUTH_TOKEN: capability } : {}) },
      extraFiles,
      cleanup: async () => {
        await Promise.all(opened.map((file) => file.close()))
      },
    }
  } catch (error) {
    await Promise.all(opened.map((file) => file.close()))
    throw error
  }
}
