import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPermissionService } from '@/permissions'
import { DEFAULT_SANDBOX_ENV } from '@/sandbox/policy'

import { startCodingBroker, type CodingBroker } from './broker'
import { CodingAgentService, codingRequestSchema } from './index'
import { runCodingAgent, type CodingRunOptions } from './runner'
import { runCodingProcess } from './worktree'

let root: string
const access = 'fixture-codex-access-canary'
const refresh = 'fixture-codex-refresh-canary'
const idToken = 'fixture-codex-id-canary'
const thread = '0199abcd-1234-7123-8123-123456789abc'
const auth = {
  resolve: async () => ({
    provider: 'openai-codex' as const,
    type: 'oauth' as const,
    token: access,
    accountId: 'fixture-account',
    secrets: [access, refresh, idToken],
  }),
}
// A real subprocess consumes the generated TOML and wire SSE, edits its real
// checkout, runs a command, and persists its own context for the next process.
const fakeCodex = `#!${process.execPath}
const argv = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const config = Bun.TOML.parse(await Bun.file(home + '/config.toml').text());
const provider = config.model_providers[config.model_provider];
if (provider.requires_openai_auth !== false || provider.supports_websockets !== false ||
    provider.capabilities.remote_compaction !== 'unsupported' ||
    await Bun.file(home + '/auth.json').exists()) process.exit(11);
if (argv.slice(0,3).join(' ') !== 'exec --json --dangerously-bypass-approvals-and-sandbox' ||
    argv.at(-1) !== '-') process.exit(12);
const resume = argv[3] === 'resume';
const state = home + '/fixture-thread.json';
const prior = resume ? await Bun.file(state).json() : null;
if (resume && (argv[4] !== prior.thread || argv[4] !== '${thread}')) process.exit(13);
const prompt = await new Response(Bun.stdin.stream()).text();
const env = {...process.env};
delete env.TYPECLAW_CODING_AGENT_CAPABILITY;
await Bun.write(home + '/observed.json', JSON.stringify({argv,env,prior}));
console.log(JSON.stringify({type:'thread.started',thread_id:'${thread}'}));
console.log(JSON.stringify({type:'turn.started'}));
const response = await fetch(provider.base_url + '/responses', {
  method:'POST', headers:{authorization:'Bearer '+process.env[provider.env_key],'content-type':'application/json'},
  body:JSON.stringify({model:config.model,stream:true,store:false,input:[{role:'user',content:prompt}]})
});
if (!response.ok) process.exit(14);
const frames = (await response.text()).split('\\n\\n').filter(Boolean).map(line=>JSON.parse(line.slice(6)));
const tool = frames.find(frame=>frame.type==='response.output_item.done').item;
const args = JSON.parse(tool.arguments);
await Bun.write('generated.txt', args.text + prompt);
if (await Bun.file('source.txt').exists()) {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const mark = Bun.spawn(['git','update-index',flag,'--','source.txt'], {
      env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'},
      stdout:'ignore',stderr:'ignore'
    });
    if (await mark.exited !== 0) process.exit(16);
  }
  await Bun.write('source.txt', 'tracked: ' + prompt);
}
const command = Bun.spawn(['/bin/sh','-c','printf command-ran'],{env:{PATH:'/usr/bin:/bin'},stdout:'pipe'});
const commandOutput = await new Response(command.stdout).text();
if (await command.exited !== 0 || commandOutput !== 'command-ran') process.exit(15);
await Bun.write(state, JSON.stringify({thread:'${thread}',prompt}));
console.error(process.env[provider.env_key]);
console.error(JSON.stringify(frames));
console.log(JSON.stringify({type:'item.completed',item:{id:'final',type:'agent_message',text:resume?'続きも完了しました':'완료했습니다'}}));
if (prompt === 'malformed') console.log('{"type":');
if (prompt !== 'no-terminal') console.log(JSON.stringify({type:prompt==='failed'?'turn.failed':'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1},error:{message:'fixture'}}));
if (prompt === 'nonzero') process.exit(3);
`

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-runner-')))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'codex'), fakeCodex)
  await chmod(join(root, 'bin', 'codex'), 0o755)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function upstream() {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe('/backend-api/codex/responses')
      expect(request.headers.get('authorization')).toBe(`Bearer ${access}`)
      expect(request.headers.get('chatgpt-account-id')).toBe('fixture-account')
      const body = await request.json()
      expect(body).toMatchObject({ model: 'gpt-6-sol', stream: true, store: false })
      const frames = [
        {
          type: 'response.output_item.done',
          item: { type: 'function_call', name: 'fixture_edit', arguments: JSON.stringify({ text: 'generated: ' }) },
        },
        { type: 'response.output_text.delta', delta: `${access} ${refresh} ${idToken}` },
        { type: 'response.completed' },
      ]
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
}

// This exercises POSIX process groups, shebangs and shell commands. The real
// delegated runner is Linux-only; macOS also supports this credential-free fixture.
describe.skipIf(process.platform === 'win32')('Codex runner integration', () => {
  test('shared service runs a fake codex executable, resumes its thread and preserves source isolation', async () => {
    const source = join(root, 'source')
    await mkdir(source)
    const execute = (argv: readonly string[], cwd: string, env?: Record<string, string>) =>
      runCodingProcess(argv, cwd, {
        ...DEFAULT_SANDBOX_ENV,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ...env,
      })
    await execute(['git', 'init', source], root)
    await writeFile(join(source, 'source.txt'), 'baseline\n')
    await writeFile(join(source, '.gitignore'), 'workspace/\n.typeclaw/\n')
    await execute(['git', 'add', '.'], source)
    await execute(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], source)
    const before = await execute(['git', 'rev-parse', 'HEAD'], source)
    const server = upstream()
    const brokers: CodingBroker[] = []
    const childIndexes: Buffer[] = []
    const service = new CodingAgentService(source, {
      executor: () => execute,
      sourcePath: (path) => path,
      writeArtifact: (path, text) => writeFile(path, text),
      auth: async () => auth,
      run: async (options) => {
        const result = await runCodingAgent(options, {
          command: async (argv, env) => ({
            argv: [...argv],
            env: { ...DEFAULT_SANDBOX_ENV, PATH: `${root}/bin:/usr/bin:/bin`, ...env },
          }),
          broker: async (options) => {
            const broker = await startCodingBroker(options, { upstream: new URL(server.url) })
            brokers.push(broker)
            return broker
          },
        })
        childIndexes.push(await readFile(join(options.workspace.taskRoot, 'git', 'worktrees', 'worktree', 'index')))
        return result
      },
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
          engine: 'codex',
          repo: source,
          modelRef: 'openai-codex/gpt-6-sol',
          prompt: '첫 작업',
        }),
        caller,
      )
      expect(first).toMatchObject({
        state: 'completed',
        engine: 'codex',
        finalMessage: '완료했습니다',
        changedFiles: ['generated.txt', 'source.txt'],
      })
      if (typeof first.worktreePath !== 'string') throw new Error('Missing worktree')
      const taskRoot = join(first.worktreePath, '..')
      const indexPath = join(taskRoot, 'git', 'worktrees', 'worktree', 'index')
      expect(childIndexes[0]).toEqual(await readFile(indexPath))
      const second = await service.execute(
        codingRequestSchema.parse({
          action: 'run',
          engine: 'codex',
          taskId: first.taskId,
          prompt: '次の作業',
        }),
        caller,
      )
      expect(second).toMatchObject({ state: 'completed', finalMessage: '続きも完了しました' })
      if (typeof second.patchPath !== 'string' || typeof second.worktreePath !== 'string')
        throw new Error('Missing artifacts')
      expect(await readFile(second.patchPath, 'utf8')).toContain('次の作業')
      expect(await readFile(second.patchPath, 'utf8')).toContain('+tracked: 次の作業')
      expect(second.changedFiles).toEqual(['generated.txt', 'source.txt'])
      expect(childIndexes[1]).toEqual(await readFile(indexPath))
      const observed = JSON.parse(await readFile(join(taskRoot, 'codex', 'observed.json'), 'utf8'))
      expect(observed.argv).toEqual([
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        'resume',
        thread,
        '-',
      ])
      expect(observed.prior).toEqual({ thread, prompt: '첫 작업' })
      for (const key of [
        'OPENAI_API_KEY',
        'CODEX_API_KEY',
        'ANTHROPIC_API_KEY',
        'OPENAI_BASE_URL',
        'CHATGPT_ACCOUNT_ID',
      ]) {
        expect(observed.env[key]).toBeUndefined()
      }
      expect(await Bun.file(join(taskRoot, 'codex', 'auth.json')).exists()).toBe(false)
      expect(await execute(['git', 'status', '--porcelain'], source)).toBe('')
      expect(await execute(['git', 'rev-parse', 'HEAD'], source)).toBe(before)
      const files = await Array.fromAsync(new Bun.Glob('{codex,output}/**/*').scan({ cwd: taskRoot, onlyFiles: true }))
      for (const file of files) {
        const contents = await readFile(join(taskRoot, file), 'utf8')
        for (const canary of [access, refresh, idToken, ...brokers.map((b) => b.capability)])
          expect(contents).not.toContain(canary)
      }
      const registry = await readFile(join(source, '.typeclaw', 'coding-agent-tasks.json'), 'utf8')
      for (const canary of [access, refresh, idToken]) expect(registry).not.toContain(canary)
      expect(JSON.parse(registry)[0].sessionId).toBe(thread)
      expect(brokers[0]?.capability).not.toBe(brokers[1]?.capability)
      for (const broker of brokers) await expect(fetch(broker.baseUrl)).rejects.toThrow()
      await expect(
        service.execute(
          codingRequestSchema.parse({
            action: 'run',
            engine: 'claude',
            taskId: first.taskId,
            prompt: 'wrong engine',
          }),
          caller,
        ),
      ).rejects.toThrow('recorded engine')
      expect(
        await service.execute(
          codingRequestSchema.parse({ action: 'dispose', taskId: first.taskId, discard: true }),
          caller,
        ),
      ).toMatchObject({ state: 'disposed' })
    } finally {
      await service.stop()
      server.stop(true)
      await Promise.all(brokers.map((broker) => broker.close()))
    }
  })

  test.each([
    ['no-terminal', 'incomplete'],
    ['nonzero', 'failed'],
    ['malformed', 'failed'],
    ['failed', 'failed'],
  ] as const)('preserves partial Codex work on %s', async (prompt, state) => {
    for (const part of ['codex', 'output', 'worktree']) await mkdir(join(root, part))
    const server = upstream()
    const options: CodingRunOptions = {
      engine: 'codex',
      workspace: {
        source: root,
        taskRoot: root,
        baseSha: 'a'.repeat(40),
        sourceIdentity: 'fixture',
      },
      auth,
      model: 'gpt-6-sol',
      allowedModels: ['gpt-6-sol'],
      mode: 'code',
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt,
      timeoutSeconds: 10,
      writeArtifact: (path, text) => writeFile(path, text),
    }
    try {
      const result = await runCodingAgent(options, {
        command: async (argv, env) => ({
          argv: [...argv],
          env: { ...DEFAULT_SANDBOX_ENV, PATH: `${root}/bin:/usr/bin:/bin`, ...env },
        }),
        broker: (options) => startCodingBroker(options, { upstream: new URL(server.url) }),
      })
      expect(result.state).toBe(state)
      expect(result.sessionId).toBe(thread)
      expect(await readFile(join(root, 'worktree', 'generated.txt'), 'utf8')).toBe(`generated: ${prompt}`)
      for (const output of await readdir(join(root, 'output'))) {
        const text = await readFile(join(root, 'output', output), 'utf8')
        for (const canary of [access, refresh, idToken]) expect(text).not.toContain(canary)
      }
    } finally {
      server.stop(true)
    }
  })

  test.each(['cancel', 'timeout', 'spawn'] as const)('revokes Codex capability on %s', async (kind) => {
    for (const part of ['codex', 'output', 'worktree']) await mkdir(join(root, part))
    const requested = Promise.withResolvers<void>()
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        requested.resolve()
        return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const abort = new AbortController()
    let broker: CodingBroker | undefined
    const options: CodingRunOptions = {
      engine: 'codex',
      workspace: {
        source: root,
        taskRoot: root,
        baseSha: 'a'.repeat(40),
        sourceIdentity: 'fixture',
      },
      auth,
      model: 'gpt-6-sol',
      allowedModels: ['gpt-6-sol'],
      mode: 'code',
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt: 'test',
      timeoutSeconds: kind === 'timeout' ? 0.1 : 10,
      signal: abort.signal,
      writeArtifact: (path, text) => writeFile(path, text),
    }
    try {
      const running = runCodingAgent(options, {
        command: async (argv, env) => ({
          argv: kind === 'spawn' ? ['/no-such-codex-executable'] : [...argv],
          env: { ...DEFAULT_SANDBOX_ENV, PATH: `${root}/bin:/usr/bin:/bin`, ...env },
        }),
        broker: async (options) => {
          broker = await startCodingBroker(options, { upstream: new URL(server.url) })
          return broker
        },
      })
      if (kind === 'cancel') {
        await requested.promise
        abort.abort()
      }
      expect((await running).state).toBe(kind === 'cancel' ? 'cancelled' : kind === 'timeout' ? 'incomplete' : 'failed')
      if (!broker) throw new Error('Broker never started')
      await expect(fetch(broker.baseUrl)).rejects.toThrow()
    } finally {
      abort.abort()
      server.stop(true)
      await broker?.close()
    }
  })
})
