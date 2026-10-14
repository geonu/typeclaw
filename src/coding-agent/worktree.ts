import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { createAndOpenAnchoredDirectory, writeFileAnchored } from '@/agent/tool-file-safety'
import {
  codingSourceMaskDirs,
  CODING_MASK_FILES,
  CODING_SOURCE,
  assertCodingDirectory,
  prepareCodingCommand,
} from '@/sandbox/coding-agent'
import { DEFAULT_SANDBOX_ENV } from '@/sandbox/policy'

export type CodingExecutor = (argv: readonly string[], cwd: string, env?: Record<string, string>) => Promise<string>
export type CodingWorkspace = {
  readonly source: string
  readonly taskRoot: string
  readonly baseSha: string
  readonly sourceIdentity: string
  readonly dirtySource: boolean
}
export type ChangeArtifacts = {
  readonly changedFiles: readonly string[]
  readonly untrackedFiles: readonly string[]
  readonly patchPath: string
  readonly oversized: boolean
}
const MAX_ARTIFACT = 64 * 1024 * 1024

// This executor is constructed by the trusted service, never supplied by a model.
export function codingGitExecutor(
  source: string,
  taskRoot: string,
  signal?: AbortSignal,
  mode: 'code' | 'plan' = 'code',
): CodingExecutor {
  return async (argv, cwd, env) => {
    const prepared = await prepareCodingCommand(argv, {
      source,
      taskRoot,
      mode,
      cwd,
      env: {
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        ...env,
      },
    })
    try {
      return await runCodingProcess(
        ['bash', '-c', `exec ${prepared.commandString}`],
        cwd,
        prepared.spawnEnv,
        signal,
        prepared.extraFiles,
      )
    } finally {
      await prepared.cleanup()
    }
  }
}

export async function runCodingProcess(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string> = DEFAULT_SANDBOX_ENV,
  signal?: AbortSignal,
  extraFiles: Array<number | 'ignore'> = [],
): Promise<string> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000)
  const [program, ...args] = argv
  if (!program) throw new Error('Empty Git command.')
  const child = spawn(program, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...extraFiles] })
  const exited = once(child, 'close')
  const cancel = () => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const consume = async (stream: NodeJS.ReadableStream): Promise<string> => {
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const value of stream) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
      size += bytes.byteLength
      if (size > MAX_ARTIFACT) {
        cancel()
        throw new Error('Coding artifact exceeds 64 MiB; partial work is preserved.')
      }
      chunks.push(bytes)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
  if (!child.stdout || !child.stderr) throw new Error('Git pipes unavailable.')
  const reads = [consume(child.stdout), consume(child.stderr)]
  try {
    const [output, , exit] = await Promise.all([...reads, exited])
    if (!Array.isArray(exit) || exit[0] !== 0)
      throw new Error('Sandboxed Git operation failed; source or task Git state may be unsupported.')
    if (typeof output !== 'string') throw new Error('Git output unavailable.')
    return output
  } finally {
    signal?.removeEventListener('abort', cancel)
    cancel()
    await Promise.allSettled([exited, ...reads])
  }
}

export async function createCodingWorkspace(
  source: string,
  taskRoot: string,
  execute: CodingExecutor,
  sourcePath = CODING_SOURCE,
): Promise<CodingWorkspace> {
  await assertCodingDirectory(source)
  await assertCodingDirectory(taskRoot)
  const identity = await lstat(source)
  const git = (...args: string[]) =>
    execute(['git', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], taskRoot)
  const root = (await git('-C', sourcePath, 'rev-parse', '--show-toplevel')).trim()
  if (root !== sourcePath) throw new Error('Select a repository root, not a subdirectory.')
  const baseSha = (await git('-C', sourcePath, 'rev-parse', '--verify', 'HEAD^{commit}')).trim()
  if (!/^[a-f0-9]{40,64}$/.test(baseSha)) throw new Error('Source has no committed HEAD.')
  const tree = (await git('-C', sourcePath, 'ls-tree', '-rz', '--name-only', baseSha)).split('\0').filter(Boolean)
  const protectedPath = tree.find(
    (name) =>
      CODING_MASK_FILES.some((file) => name === file) ||
      codingSourceMaskDirs(source, taskRoot).some((dir) => name === dir || name.startsWith(`${dir}/`)),
  )
  if (protectedPath)
    throw new Error(
      'Selected source revision contains a protected canonical/private path. Select a clean committed revision.',
    )
  const dirtySource = (await git('-C', sourcePath, 'status', '--porcelain', '-z')).length > 0
  await git('init', '--bare', join(taskRoot, 'git'))
  // file transport copies objects and --depth=1 excludes unrelated history.
  await git(
    '--git-dir',
    join(taskRoot, 'git'),
    '-c',
    'protocol.file.allow=always',
    'fetch',
    '--depth=1',
    '--no-tags',
    `file://${sourcePath}`,
    baseSha,
  )
  await git('--git-dir', join(taskRoot, 'git'), 'worktree', 'add', '--detach', join(taskRoot, 'worktree'), baseSha)
  const after = await lstat(source)
  if (identity.dev !== after.dev || identity.ino !== after.ino) throw new Error('Source repository identity changed.')
  return { source, taskRoot, baseSha, sourceIdentity: `${identity.dev}:${identity.ino}`, dirtySource }
}

export async function captureCodingChanges(
  workspace: CodingWorkspace,
  execute: CodingExecutor,
  writeArtifact: (path: string, text: string) => Promise<void>,
): Promise<ChangeArtifacts> {
  const { taskRoot, baseSha } = workspace
  await assertCodingDirectory(taskRoot)
  const cwd = join(taskRoot, 'worktree')
  const git = (...args: string[]) =>
    execute(['git', '--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args], cwd)
  const untrackedFiles = (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean)
  // Temporary index lives in sandbox scratch, not in the CLI's mutable index.
  const temporary = `/tmp/typeclaw-index-${crypto.randomUUID()}`
  // Each bwrap invocation has fresh /tmp: construct and consume the index in ONE process.
  // The helper script is code we supply, with paths passed as positional parameters.
  const script = [
    'set -eu',
    // A model-controlled replace ref must not redefine the recorded baseline.
    'export GIT_NO_REPLACE_OBJECTS=1',
    'index="$(git rev-parse --git-path index)"',
    'objects="$(git rev-parse --git-path objects)"',
    'export GIT_INDEX_FILE="$1"',
    'export GIT_OBJECT_DIRECTORY="$1.objects"',
    'export GIT_ALTERNATE_OBJECT_DIRECTORIES="$objects"',
    'mkdir "$GIT_OBJECT_DIRECTORY"',
    'trap \'rm -f "$GIT_INDEX_FILE"; rm -rf "$GIT_OBJECT_DIRECTORY"\' EXIT',
    'if [ -f "$index" ]; then cp "$index" "$GIT_INDEX_FILE"; else git -c core.hooksPath=/dev/null read-tree HEAD; fi',
    'git -c core.hooksPath=/dev/null add -A -- .',
    'if [ "$3" = patch ]; then',
    '  git -c core.hooksPath=/dev/null diff --cached --binary --full-index --no-ext-diff --no-textconv "$2" --',
    'else',
    '  git -c core.hooksPath=/dev/null diff --cached --raw --numstat -z --no-renames --no-ext-diff --no-textconv "$2" --',
    'fi',
  ].join('\n')
  let patch: string
  try {
    patch = await execute(['bash', '-c', script, 'capture', temporary, baseSha, 'patch'], cwd)
  } catch (error) {
    if (error instanceof Error && error.message.includes('64 MiB')) {
      return { changedFiles: [], untrackedFiles, patchPath: join(taskRoot, 'output', 'changes.patch'), oversized: true }
    }
    throw error
  }
  const inventory = await execute(['bash', '-c', script, 'capture', temporary, baseSha, 'inventory'], cwd)
  const records = inventory.split('\0').filter(Boolean)
  const changes: Array<{
    path: string
    status: string
    oldMode: string
    mode: string
    binary: boolean
    untracked: boolean
  }> = []
  const binary = new Set<string>()
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? ''
    const raw = /^:(\d+) (\d+) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(record)
    if (raw) {
      const path = records[++i]
      if (!path || !raw[1] || !raw[2] || !raw[3]) throw new Error('Git change inventory is incomplete.')
      changes.push({
        path,
        status: raw[3],
        oldMode: raw[1],
        mode: raw[2],
        binary: false,
        untracked: untrackedFiles.includes(path),
      })
    } else if (record.startsWith('-\t-\t')) binary.add(record.slice(4))
  }
  for (const change of changes) change.binary = binary.has(change.path)
  const changedFiles = changes.map((change) => change.path)
  const patchPath = join(taskRoot, 'output', 'changes.patch')
  await writeArtifact(patchPath, patch)
  await writeArtifact(
    join(taskRoot, 'output', 'changes.json'),
    JSON.stringify(
      {
        baseSha,
        changedFiles,
        untrackedFiles,
        changes,
      },
      null,
      2,
    ),
  )
  return { changedFiles, untrackedFiles, patchPath, oversized: false }
}

export async function writeCodingArtifact(agentDir: string, targetPath: string, text: string): Promise<void> {
  await writeFileAnchored({ agentDir, targetPath, data: Buffer.from(text), tool: 'coding_agent' })
}

export async function createTaskDirectory(agentDir: string, taskId: string): Promise<string> {
  const root = join(agentDir, 'workspace', 'coding-agents')
  const taskRoot = join(root, taskId)
  if (process.platform === 'linux') {
    const parent = await createAndOpenAnchoredDirectory(root)
    try {
      const anchored = `/proc/self/fd/${parent.fd}/${taskId}`
      await mkdir(anchored, { mode: 0o700 })
      const task = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try {
        for (const part of ['claude', 'output']) await mkdir(`/proc/self/fd/${task.fd}/${part}`, { mode: 0o700 })
      } finally {
        await task.close()
      }
    } finally {
      await parent.close()
    }
    return taskRoot
  }
  // Dev-stage fixture setup. Production invocation still requires Linux bwrap.
  // No-follow every existing component, including the shared workspace.
  for (const path of [agentDir, join(agentDir, 'workspace'), root]) {
    await mkdir(path, { recursive: true })
    await assertCodingDirectory(path)
  }
  await mkdir(taskRoot, { mode: 0o700 })
  for (const part of ['claude', 'output']) await mkdir(join(taskRoot, part), { mode: 0o700 })
  return taskRoot
}

export async function disposeCodingWorkspace(workspace: CodingWorkspace, execute: CodingExecutor): Promise<void> {
  await assertCodingDirectory(workspace.taskRoot)
  const exists = await lstat(join(workspace.taskRoot, 'worktree')).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  })
  if (exists)
    await execute(
      [
        'git',
        '--git-dir',
        join(workspace.taskRoot, 'git'),
        'worktree',
        'remove',
        '--force',
        join(workspace.taskRoot, 'worktree'),
      ],
      workspace.taskRoot,
    )
  if (process.platform === 'linux') {
    const parent = await createAndOpenAnchoredDirectory(dirname(workspace.taskRoot), false)
    try {
      await rm(`/proc/self/fd/${parent.fd}/${workspace.taskRoot.split('/').at(-1)}`, { recursive: true })
    } finally {
      await parent.close()
    }
  } else await rm(workspace.taskRoot, { recursive: true })
}

export async function writeTaskRegistry(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await assertCodingDirectory(dirname(path))
  const parent = process.platform === 'linux' ? await createAndOpenAnchoredDirectory(dirname(path), false) : undefined
  try {
    const target = parent ? `/proc/self/fd/${parent.fd}/coding-agent-tasks.json` : path
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await file.writeFile(text)
    } finally {
      await file.close()
    }
    await rename(temporary, target)
  } finally {
    await parent?.close()
  }
}

export async function resolveCodingSource(
  agentDir: string,
  repo: string,
  mountNames: readonly string[],
): Promise<string> {
  const target = resolve(agentDir, repo)
  const roots = [agentDir, ...mountNames.map((name) => join(agentDir, 'mounts', name))]
  if (!roots.some((root) => target === root || target.startsWith(`${join(agentDir, 'workspace')}/`))) {
    throw new Error('Repository is not an accessible agent, workspace, or configured mount root.')
  }
  const actual = await realpath(target)
  if (actual !== target) throw new Error('Repository symlink aliases are not supported; select the configured root.')
  return actual
}
