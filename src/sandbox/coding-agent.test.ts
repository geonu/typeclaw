import { afterEach, beforeEach, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import { CLAUDE_CODE_VERSION } from '@/coding-agent/claude'
import { CODEX_CLI_VERSION } from '@/coding-agent/codex'
import { runCodingProcess } from '@/coding-agent/worktree'

import { buildSandboxedCommand } from './build'
import { CODING_SOURCE, codingSandboxPolicy, prepareCodingCommand } from './coding-agent'

let root: string
let source: string
let taskRoot: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coding-sandbox-')))
  source = join(root, 'source')
  taskRoot = join(source, 'workspace', 'coding-agents', crypto.randomUUID())
  for (const path of [
    source,
    join(source, '.git'),
    taskRoot,
    join(taskRoot, 'git'),
    join(taskRoot, 'worktree'),
    join(taskRoot, 'claude'),
    join(taskRoot, 'codex'),
    join(taskRoot, 'output'),
  ]) {
    await mkdir(path, { recursive: true })
  }
  await writeFile(join(source, 'secrets.json'), 'fixture-provider-canary')
  await mkdir(join(source, '.typeclaw'))
  await mkdir(join(source, '.claude'))
  await writeFile(join(source, '.claude', '.credentials.json'), 'fixture-provider-canary')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test.each(['code', 'plan', 'snapshot'] as const)('excludes credential write locations in %s mode', async (mode) => {
  const policy = await codingSandboxPolicy(
    {
      source,
      taskRoot,
      mode,
      cwd: join(taskRoot, 'worktree'),
      env: { TYPECLAW_CODING_AGENT_CAPABILITY: 'local-capability', CODEX_HOME: join(taskRoot, 'codex') },
    },
    'proc-bind',
  )
  const built = buildSandboxedCommand('true', policy)
  expect(built.argv).toContain('--unshare-all')
  expect(built.argv).toContain('--die-with-parent')
  expect(built.argv).toContain('--new-session')
  expect(built.argv).toContain('--share-net')
  expect(policy.mounts).toEqual([
    ...(mode === 'snapshot'
      ? [{ type: 'ro-bind' as const, source: join(source, '.git'), dest: posix.join(CODING_SOURCE, '.git') }]
      : []),
    { type: 'bind', source: taskRoot, dest: taskRoot },
    ...(mode === 'plan'
      ? ['git', 'worktree'].map((name) => ({
          type: 'ro-bind' as const,
          source: join(taskRoot, name),
          dest: join(taskRoot, name),
        }))
      : []),
  ])
  // No live directory containing canonical credentials, present or future siblings,
  // or replacement inodes is mounted at either the real or synthetic source path.
  expect(built.argv).not.toContain(source)
  expect(built.argv).not.toContain(CODING_SOURCE)
  expect(built.spawnEnv.TYPECLAW_CODING_AGENT_CAPABILITY).toBe('local-capability')
  expect(built.spawnEnv.CODEX_HOME).toBe(join(taskRoot, 'codex'))
  expect(built.spawnEnv.OPENAI_API_KEY).toBeUndefined()
  expect(built.spawnEnv.CODEX_API_KEY).toBeUndefined()
  expect(built.spawnEnv.ANTHROPIC_API_KEY).toBeUndefined()
  expect(built.spawnEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
})

test('refuses a task-root symlink instead of binding another directory', async () => {
  const alias = join(root, 'alias')
  await symlink(taskRoot, alias)
  await expect(codingSandboxPolicy({ source, taskRoot: alias, mode: 'code', cwd: alias }, 'proc-bind')).rejects.toThrow(
    'symlink',
  )
})

test('refuses a Git-directory alias to the credential write directory', async () => {
  const git = join(source, '.git')
  await rm(git, { recursive: true })
  await symlink(source, git)
  await expect(codingSandboxPolicy({ source, taskRoot, mode: 'snapshot', cwd: taskRoot }, 'proc-bind')).rejects.toThrow(
    'symlink',
  )
})

test('refuses canonical credential hardlinks into otherwise allowed Git metadata', async () => {
  await link(join(source, 'secrets.json'), join(source, '.git', 'provider-copy'))
  await expect(
    codingSandboxPolicy({ source, taskRoot, mode: 'snapshot', cwd: taskRoot }, 'proc-bind'),
  ).rejects.toThrow()
})

test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap'))(
  'real bwrap hides canonical bytes and enforces plan writes with pinned descriptors',
  async () => {
    const prepared = await prepareCodingCommand(
      [
        '/bin/sh',
        '-c',
        'for fd in /proc/self/fd/*; do test ! -d "$fd" || exit 90; done; test ! -s /typeclaw-coding-source/secrets.json && test ! -e /home/agent && ! touch blocked && ! touch ../git/blocked && touch ../codex/session-state && printf safe',
      ],
      { source, taskRoot, mode: 'plan', cwd: join(taskRoot, 'worktree') },
    )
    try {
      expect(
        await runCodingProcess(
          ['bash', '-c', `exec ${prepared.commandString}`],
          taskRoot,
          prepared.spawnEnv,
          undefined,
          prepared.extraFiles,
        ),
      ).toBe('safe')
    } finally {
      await prepared.cleanup()
    }
  },
)

test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap') || !Bun.which('codex'))(
  'the pinned Codex executable is reachable through the real delegated profile',
  async () => {
    const prepared = await prepareCodingCommand(['codex', '--version'], {
      source,
      taskRoot,
      mode: 'code',
      cwd: join(taskRoot, 'worktree'),
    })
    try {
      expect(
        await runCodingProcess(
          ['bash', '-c', `exec ${prepared.commandString}`],
          taskRoot,
          prepared.spawnEnv,
          undefined,
          prepared.extraFiles,
        ),
      ).toContain(CODEX_CLI_VERSION)
    } finally {
      await prepared.cleanup()
    }
  },
)

test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap') || !Bun.which('claude'))(
  'the pinned installed Claude executable is reachable through the real delegated profile',
  async () => {
    const prepared = await prepareCodingCommand(['claude', '--version'], {
      source,
      taskRoot,
      mode: 'code',
      cwd: join(taskRoot, 'worktree'),
    })
    try {
      expect(
        await runCodingProcess(
          ['bash', '-c', `exec ${prepared.commandString}`],
          taskRoot,
          prepared.spawnEnv,
          undefined,
          prepared.extraFiles,
        ),
      ).toContain(CLAUDE_CODE_VERSION)
    } finally {
      await prepared.cleanup()
    }
  },
)

test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap'))(
  'a delegated descendant cannot inspect or signal a credential-bearing sibling',
  async () => {
    const sentinel = Bun.spawn(
      [process.execPath, '-e', 'Bun.serve({port:0,fetch(){return new Response("fixture")}}); console.log("READY")'],
      {
        env: { PATH: '/usr/local/bin:/usr/bin:/bin', FIXTURE_SECRET: 'coding-proc-canary' },
        stdout: 'pipe',
        stderr: 'ignore',
      },
    )
    const reader = sentinel.stdout.getReader()
    try {
      const ready = await reader.read()
      expect(new TextDecoder().decode(ready.value)).toContain('READY')
      const command = `! cat /proc/${sentinel.pid}/environ && ! readlink /proc/${sentinel.pid}/root && ! kill -0 ${sentinel.pid} && env`
      const prepared = await prepareCodingCommand(['/bin/sh', '-c', command], {
        source,
        taskRoot,
        mode: 'code',
        cwd: join(taskRoot, 'worktree'),
        env: { TYPECLAW_CODING_AGENT_CAPABILITY: 'local-capability' },
      })
      try {
        expect(prepared.commandString).not.toContain('local-capability')
        const text = await runCodingProcess(
          ['bash', '-c', `exec ${prepared.commandString}`],
          taskRoot,
          prepared.spawnEnv,
          undefined,
          prepared.extraFiles,
        )
        expect(text).not.toContain('coding-proc-canary')
        expect(text).not.toContain('ANTHROPIC_API_KEY=')
        expect(text).not.toContain('OPENAI_API_KEY=')
        expect(text).not.toContain('CODEX_API_KEY=')
        expect(text).toContain('TYPECLAW_CODING_AGENT_CAPABILITY=local-capability')
      } finally {
        await prepared.cleanup()
      }
    } finally {
      reader.releaseLock()
      sentinel.kill('SIGKILL')
      await sentinel.exited
    }
  },
)
