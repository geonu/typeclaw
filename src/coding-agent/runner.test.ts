import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPermissionService } from '@/permissions'

import { startCodingBroker, type CodingBroker } from './broker'
import { ClaudeStreamParser } from './claude'
import { CodingAgentService, codingRequestSchema } from './index'
import { runCodingAgent, type CodingRunOptions } from './runner'
import { runCodingProcess } from './worktree'

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coding-runner-')))
  for (const part of ['worktree', 'claude', 'output']) await mkdir(join(root, part))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const script = `
const args = process.argv.slice(2);
const resume = args.indexOf('--resume');
const sessionId = args[(resume < 0 ? args.indexOf('--session-id') : resume) + 1];
const prompt = await new Response(Bun.stdin.stream()).text();
console.log(JSON.stringify({type:'system', session_id:sessionId}));
const state = process.env.CLAUDE_CONFIG_DIR + '/fixture-state';
if (resume >= 0 && !(await Bun.file(state).exists())) process.exit(2);
const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method:'POST', headers:{authorization:'Bearer '+process.env.ANTHROPIC_AUTH_TOKEN,'content-type':'application/json'},
  body:JSON.stringify({model:args[args.indexOf('--model')+1],messages:[{role:'user',content:prompt}]})
});
await response.text();
await Bun.write('generated.txt', prompt);
const command = Bun.spawn(['/bin/sh','-c','printf command-ran'], {env:{PATH:'/usr/bin:/bin'},stdout:'pipe'});
if (await command.exited !== 0) process.exit(3);
await Bun.write(state, 'saved');
console.error(process.env.ANTHROPIC_AUTH_TOKEN);
console.log(JSON.stringify({type:'result',subtype:'success',session_id:sessionId,result:resume < 0 ? '완료했습니다' : '続きも完了しました'}));
`

describe('headless runner', () => {
  test('public service composes real Git, fake CLI, broker, resume and full result artifacts', async () => {
    const source = join(root, 'source')
    await mkdir(source)
    const execute = (argv: readonly string[], cwd: string, env?: Record<string, string>) =>
      runCodingProcess(argv, cwd, {
        PATH: '/usr/bin:/bin',
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        ...env,
      })
    await execute(['git', 'init', source], root)
    await writeFile(join(source, 'source.txt'), 'baseline\n')
    await writeFile(join(source, '.gitignore'), 'workspace/\n.typeclaw/\n')
    // Real agent HEADs contain force-backed-up private data. Delegation already
    // requires private-surface authority; these are not canonical credentials.
    await mkdir(join(source, 'memory'))
    await mkdir(join(source, 'sessions'))
    await writeFile(join(source, 'memory', 'topic.md'), 'Authorized private context.\n')
    await writeFile(join(source, 'sessions', 'session.jsonl'), '{"type":"fixture"}\n')
    await execute(['git', 'add', '.'], source)
    await execute(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], source)
    const fake = join(root, 'fake-claude.js')
    await writeFile(fake, script)
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        expect(request.headers.get('x-api-key')).toBe('provider-canary')
        return Response.json({ ok: true })
      },
    })
    const service = new CodingAgentService(source, {
      executor: () => execute,
      sourcePath: (path) => path,
      writeArtifact: (path, text) => writeFile(path, text),
      auth: async () => ({
        resolve: async () => ({ type: 'api_key', token: 'provider-canary', secrets: ['provider-canary'] }),
      }),
      run: (options) =>
        runCodingAgent(options, {
          broker: (options) => startCodingBroker(options, { upstream: new URL(upstream.url) }),
          command: async (argv, env) => ({
            argv: [process.execPath, fake, ...argv.slice(1)],
            env: { PATH: '/usr/bin:/bin', HOME: root, ...env },
          }),
        }),
    })
    const caller = {
      sessionId: 'parent',
      origin: { kind: 'tui' as const, sessionId: 'parent' },
      permissions: createPermissionService(),
    }
    try {
      const first = await service.execute(
        codingRequestSchema.parse({
          action: 'run',
          engine: 'claude',
          repo: source,
          modelRef: 'anthropic/claude-opus-5-5',
          prompt: '첫 작업',
        }),
        caller,
      )
      expect(first.state).toBe('completed')
      expect(first.changedFiles).toEqual(['generated.txt'])
      const second = await service.execute(
        codingRequestSchema.parse({
          action: 'run',
          engine: 'claude',
          taskId: first.taskId,
          prompt: '次の作業',
        }),
        caller,
      )
      expect(second.finalMessage).toBe('続きも完了しました')
      if (typeof second.patchPath !== 'string') throw new Error('No complete artifact')
      expect(await readFile(second.patchPath, 'utf8')).toContain('次の作業')
      expect(await execute(['git', 'status', '--porcelain'], source)).toBe('')
      expect(JSON.stringify([first, second])).not.toContain('provider-canary')
    } finally {
      await service.stop()
      upstream.stop(true)
    }
  })

  test('executes tools, saves context, explicitly resumes, and revokes each capability', async () => {
    const upstream = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ ok: true }) })
    const brokers: CodingBroker[] = []
    const file = join(root, 'fake-claude.js')
    await writeFile(file, script)
    const options: CodingRunOptions = {
      workspace: {
        source: root,
        taskRoot: root,
        baseSha: 'a'.repeat(40),
        sourceIdentity: 'fixture',
        dirtySource: false,
      },
      auth: {
        resolve: async () => ({
          type: 'api_key',
          token: 'fixture-provider-canary',
          secrets: ['fixture-provider-canary'],
        }),
      },
      model: 'primary',
      allowedModels: ['primary'],
      mode: 'code',
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt: '구현하고 테스트해 주세요',
      timeoutSeconds: 10,
      writeArtifact: (path, text) => writeFile(path, text),
    }
    const dependencies = {
      command: async (argv: readonly string[], env: Record<string, string>) => ({
        argv: [process.execPath, file, ...argv.slice(1)],
        env: { PATH: '/usr/bin:/bin', HOME: root, ...env },
      }),
      broker: async (opts: Parameters<typeof startCodingBroker>[0]) => {
        const broker = await startCodingBroker(opts, { upstream: new URL(upstream.url) })
        brokers.push(broker)
        return broker
      },
    }
    try {
      const first = await runCodingAgent(options, dependencies)
      expect(first.state).toBe('completed')
      expect(first.finalMessage).toBe('완료했습니다')
      expect(await readFile(join(root, 'worktree', 'generated.txt'), 'utf8')).toBe(options.prompt)
      const second = await runCodingAgent({ ...options, resume: true, prompt: '続けてください' }, dependencies)
      expect(second.state).toBe('completed')
      expect(second.finalMessage).toBe('続きも完了しました')
      expect(brokers[0]?.capability).not.toBe(brokers[1]?.capability)
      for (const broker of brokers) await expect(fetch(broker.baseUrl)).rejects.toThrow()
      const outputs = await Array.fromAsync(new Bun.Glob('*').scan(join(root, 'output')))
      for (const output of outputs) {
        const text = await readFile(join(root, 'output', output), 'utf8')
        expect(text).not.toContain('fixture-provider-canary')
        for (const broker of brokers) expect(text).not.toContain(broker.capability)
      }
    } finally {
      upstream.stop(true)
      await Promise.all(brokers.map((broker) => broker.close()))
    }
  })

  test.each(['cancel', 'timeout', 'spawn'] as const)('revokes capability on %s', async (kind) => {
    let entered: () => void = () => {}
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    const upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        entered()
        return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const abort = new AbortController()
    const file = join(root, 'fake-claude.js')
    await writeFile(file, script)
    let broker: CodingBroker | undefined
    try {
      const running = runCodingAgent(
        {
          workspace: {
            source: root,
            taskRoot: root,
            baseSha: 'a'.repeat(40),
            sourceIdentity: 'fixture',
            dirtySource: false,
          },
          auth: { resolve: async () => ({ type: 'api_key', token: 'canary', secrets: ['canary'] }) },
          model: 'primary',
          allowedModels: ['primary'],
          mode: 'code',
          sessionId: crypto.randomUUID(),
          resume: false,
          prompt: 'test',
          timeoutSeconds: kind === 'timeout' ? 0.1 : 10,
          signal: abort.signal,
          writeArtifact: (path, text) => writeFile(path, text),
        },
        {
          command: async (argv, env) => ({
            argv: kind === 'spawn' ? ['/no-such-coding-executable'] : [process.execPath, file, ...argv.slice(1)],
            env: { PATH: '/usr/bin:/bin', HOME: root, ...env },
          }),
          broker: async (opts) => {
            broker = await startCodingBroker(opts, { upstream: new URL(upstream.url) })
            return broker
          },
        },
      )
      if (kind === 'cancel') {
        await requested
        abort.abort()
      }
      const result = await running
      expect(result.state).toBe(kind === 'cancel' ? 'cancelled' : kind === 'timeout' ? 'incomplete' : 'failed')
      if (!broker) throw new Error('Broker not started')
      await expect(fetch(broker.baseUrl)).rejects.toThrow()
    } finally {
      upstream.stop(true)
      await broker?.close()
    }
  })
})

test.each([
  ['{"type":"result","subtype":"success","result":"질문이 있습니다"}\n', true, false],
  ['{"type":"result","subtype":"error_during_execution","is_error":true}\n', true, true],
  ['{"type":"assistant"}\n', false, false],
  ['{"type":', false, false],
])('parses protocol state rather than final prose: %s', (text, terminal, failed) => {
  const parser = new ClaudeStreamParser()
  parser.push(text.slice(0, 8))
  parser.push(text.slice(8))
  parser.finish()
  expect(parser.terminal).toBe(terminal)
  expect(parser.failed).toBe(failed)
  expect(parser.malformed).toBe(text === '{"type":')
})
