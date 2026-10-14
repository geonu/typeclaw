import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import {
  captureCodingChanges,
  codingGitExecutor,
  createCodingWorkspace,
  createTaskDirectory,
  runCodingProcess,
} from '@/coding-agent/worktree'

import { CODING_SOURCE, prepareCodingCommand } from './coding-agent'
import { DEFAULT_SANDBOX_ENV } from './policy'

for (const mode of ['code', 'snapshot'] as const) {
  test.skipIf(process.platform !== 'linux' || !Bun.which('bwrap'))(
    `credential rotation remains unreachable during ${mode} work`,
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'coding-rotation-')))
      try {
        const source = join(root, 'agent')
        await mkdir(source)
        const taskRoot = await createTaskDirectory(source, crypto.randomUUID())
        const env = {
          ...DEFAULT_SANDBOX_ENV,
          HOME: root,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        }
        const git = (args: string[]) => runCodingProcess(['git', ...args], source, env)
        await git(['init'])
        await writeFile(join(source, 'code.txt'), 'baseline\n')
        await git(['add', 'code.txt'])
        await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'])
        const secret = join(source, 'secrets.json')
        await writeFile(secret, 'original-canary\n', { mode: 0o600 })
        const workspace = await createCodingWorkspace(
          source,
          taskRoot,
          codingGitExecutor(source, taskRoot, undefined, 'snapshot'),
        )
        const prepared = await prepareCodingCommand(
          [
            '/bin/sh',
            '-c',
            [
              'set -eu',
              'test "$(cat code.txt)" = baseline',
              'printf delegated-work > ordinary.txt',
              'while IFS= read -r phase; do',
              '  for base in "$1" "$2"; do',
              '    for file in "$base"/secrets.json*; do',
              '      if [ -f "$file" ]; then cat "$file"; fi',
              '    done',
              '  done',
              '  printf "SAFE %s\\n" "$phase"',
              'done',
            ].join('\n'),
            'rotation',
            source,
            CODING_SOURCE,
          ],
          { source, taskRoot, mode, cwd: join(taskRoot, 'worktree') },
        )
        try {
          const child = spawn('bash', ['-c', `exec ${prepared.commandString}`], {
            cwd: taskRoot,
            env: prepared.spawnEnv,
            stdio: ['pipe', 'pipe', 'pipe', ...prepared.extraFiles],
          })
          const closed = once(child, 'close')
          if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Missing fixture pipes')
          const input = child.stdin
          const lines = createInterface({ input: child.stdout })
          let transcript = ''
          child.stdout.on('data', (chunk: Buffer) => {
            transcript += chunk.toString()
          })
          child.stderr.on('data', (chunk: Buffer) => {
            transcript += chunk.toString()
          })
          const poll = async (phase: string) => {
            const response = once(lines, 'line', { signal: AbortSignal.timeout(5_000) })
            input.write(`${phase}\n`)
            expect((await response)[0]).toBe(`SAFE ${phase}`)
          }
          try {
            await poll('before')
            const canary = `rotation-canary-${crypto.randomUUID()}`
            for (let i = 0; i < 3; i++) {
              const temporary = `${secret}.${crypto.randomUUID()}.tmp`
              await writeFile(temporary, `${canary}\n`, { mode: 0o600 })
              // Hold each rotation phase until the live child has inspected it:
              // neither the sibling nor replacement check can pass by timing luck.
              await poll(`temporary-${i}`)
              await rename(temporary, secret)
              await poll(`replaced-${i}`)
            }
            input.end()
            expect((await closed)[0]).toBe(0)
            expect(transcript).not.toContain(canary)
            expect(transcript).not.toContain('original-canary')
          } finally {
            child.kill('SIGKILL')
            await closed
            lines.close()
          }
        } finally {
          await prepared.cleanup()
        }
        expect(await readFile(join(taskRoot, 'worktree', 'ordinary.txt'), 'utf8')).toBe('delegated-work')
        const artifacts = await captureCodingChanges(
          workspace,
          codingGitExecutor(source, taskRoot, undefined, 'plan'),
          (path, text) => writeFile(path, text),
        )
        expect(artifacts.changedFiles).toEqual(['ordinary.txt'])
        expect(await readFile(artifacts.patchPath, 'utf8')).toContain('+delegated-work')
        expect(await readFile(join(source, 'code.txt'), 'utf8')).toBe('baseline\n')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
}
