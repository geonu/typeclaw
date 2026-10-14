import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CLAUDE_CODE_VERSION } from '@/coding-agent/claude'
import { runCodingProcess } from '@/coding-agent/worktree'

import { buildSandboxedCommand } from './build'
import { codingSandboxPolicy, prepareCodingCommand } from './coding-agent'

let root: string
let source: string
let taskRoot: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coding-sandbox-')))
  source = join(root, 'source')
  taskRoot = join(root, 'task')
  for (const path of [source, taskRoot, join(taskRoot, 'git'), join(taskRoot, 'worktree'), join(taskRoot, 'claude')]) {
    await mkdir(path)
  }
  await writeFile(join(source, 'secrets.json'), 'fixture-provider-canary')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test.each(['code', 'plan'] as const)('narrows mounts and environment in %s mode', async (mode) => {
  const policy = await codingSandboxPolicy(
    {
      source,
      taskRoot,
      mode,
      cwd: join(taskRoot, 'worktree'),
      env: { ANTHROPIC_AUTH_TOKEN: 'local-capability' },
    },
    'proc-bind',
  )
  const built = buildSandboxedCommand('true', policy)
  expect(built.argv).toContain('--unshare-all')
  expect(built.argv).toContain('--die-with-parent')
  expect(built.argv).toContain('--new-session')
  expect(built.argv).toContain('--share-net')
  expect(policy.mounts?.filter((mount) => mount.type === 'bind')).toEqual([
    { type: 'bind', source: taskRoot, dest: taskRoot },
  ])
  expect(policy.mounts?.filter((mount) => mount.type === 'ro-bind')).toHaveLength(mode === 'plan' ? 3 : 1)
  expect(built.spawnEnv.ANTHROPIC_AUTH_TOKEN).toBe('local-capability')
  expect(built.spawnEnv.ANTHROPIC_API_KEY).toBeUndefined()
  expect(built.spawnEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(built.argv).toContain('/typeclaw-coding-source/secrets.json')
})

test('refuses a task-root symlink instead of binding another directory', async () => {
  const alias = join(root, 'alias')
  await symlink(taskRoot, alias)
  await expect(codingSandboxPolicy({ source, taskRoot: alias, mode: 'code', cwd: alias }, 'proc-bind')).rejects.toThrow(
    'symlink',
  )
})

test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap'))(
  'real bwrap hides canonical bytes and enforces plan writes with pinned descriptors',
  async () => {
    const prepared = await prepareCodingCommand(
      [
        '/bin/sh',
        '-c',
        'for fd in /proc/self/fd/*; do test ! -d "$fd" || exit 90; done; test ! -s /typeclaw-coding-source/secrets.json && test ! -e /home/agent && ! touch blocked && printf safe',
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
        env: { ANTHROPIC_AUTH_TOKEN: 'local-capability' },
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
        expect(text).toContain('ANTHROPIC_AUTH_TOKEN=local-capability')
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
