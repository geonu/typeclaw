import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveModel } from '@/config'
import { createPermissionService } from '@/permissions'
import { DEFAULT_SANDBOX_ENV } from '@/sandbox/policy'
import type { CodingAgentProvider } from '@/secrets/coding-agent-auth'

import { startCodingBroker, type CodingBroker } from './broker'
import { CodingAgentService, codingRequestSchema } from './index'
import { omoModelSchema } from './omo'
import { runCodingAgent, type CodingRunOptions } from './runner'
import { runCodingProcess } from './worktree'

let root: string
const access = 'fixture-omo-access-canary'
const refresh = 'fixture-omo-refresh-canary'
const idToken = 'fixture-omo-id-token-canary'
const auth = {
  resolve: async (_signal?: AbortSignal, _rejected?: unknown, provider: CodingAgentProvider = 'anthropic') =>
    provider === 'anthropic'
      ? { provider, type: 'oauth' as const, token: access, secrets: [access, refresh, idToken] }
      : {
          provider,
          type: 'oauth' as const,
          token: access,
          accountId: 'fixture-account',
          secrets: [access, refresh, idToken],
        },
}
const fakeOmo = `#!${process.execPath}
import { zstdCompressSync } from 'node:zlib';
const args = process.argv.slice(2);
const id = args[args.indexOf('--session-id')+1];
const directory = args[args.indexOf('--session-dir')+1];
const agent = process.env.OMO_CODING_AGENT_DIR;
const models = await Bun.file(agent+'/models.json').json();
const settings = await Bun.file(agent+'/settings.json').json();
const config = await Bun.file(process.env.HOME+'/.omo/omo.jsonc').json();
const provider = models.providers.typeclaw;
const model = provider.models[0].id;
if (args.slice(0,3).join(' ') !== '-p --mode json' || args.at(-1) === '-' ||
    args[args.indexOf('--model')+1] !== 'typeclaw/'+model || settings.transport !== 'sse' ||
    !args.includes('--no-approve') || !args.includes('--omo-senpi-memory-disabled') ||
    config.task.default_execution_mode !== 'in-process') process.exit(11);
const state = directory+'/fixture_'+id+'.jsonl';
const prior = await Bun.file(state).exists() ? await Bun.file(state).text() : '';
const header = {type:'session',version:3,id,cwd:process.cwd()};
const prompt = await new Response(Bun.stdin.stream()).text();
const env = {...process.env};
delete env.TYPECLAW_CODING_AGENT_CAPABILITY;
await Bun.write(agent+'/observed.json', JSON.stringify({args,env,prior}));
console.log(JSON.stringify(header));
console.log(JSON.stringify({type:'agent_start'}));
const codex = provider.api === 'openai-codex-responses';
const endpoint = provider.baseUrl+(codex?'/codex/responses':'/v1/messages');
for (const selection of ['typeclaw/'+model, config.categories.quick.models[0], config.agents.explore.model, settings.compaction.model]) {
  if(selection !== 'typeclaw/'+model) process.exit(12);
  const body = JSON.stringify({model:selection.slice(9),stream:true,store:false,messages:[{role:'user',content:prompt}],input:[]});
  const response = await fetch(endpoint,{
    method:'POST',
    headers:{authorization:'Bearer '+process.env.TYPECLAW_CODING_AGENT_CAPABILITY,'content-type':'application/json',...(codex?{'content-encoding':'zstd'}:{})},
    body:codex?zstdCompressSync(Buffer.from(body)):body
  });
  const text = await response.text();
  console.error(text);
  if(!response.ok) {
    console.log(JSON.stringify({type:'agent_end',messages:[{role:'assistant',content:[{type:'text',text}],stopReason:'error'}],willRetry:false}));
    process.exit(0);
  }
}
await Bun.write('generated.txt',prompt);
const command = Bun.spawn(['/bin/sh','-c','printf command-ran'],{env:{PATH:'/usr/bin:/bin'},stdout:'pipe'});
if(await command.exited !== 0 || await new Response(command.stdout).text() !== 'command-ran') process.exit(13);
await Bun.write(state,JSON.stringify(header)+'\\n'+JSON.stringify({type:'fixture',prior,prompt})+'\\n');
console.error(process.env.TYPECLAW_CODING_AGENT_CAPABILITY);
if(prompt==='overflow') { console.log('x'.repeat(4*1024*1024+1)); process.exit(0); }
if(prompt==='deltas') {
  // Exceed the raw 16 MiB cap without turning this behavior check into an 81,920-write benchmark.
  const delta = JSON.stringify({type:'message_update',usage:{input:0,output:0},assistantMessageEvent:{type:'toolcall_delta',contentIndex:0,delta:'x'.repeat(1024*1024)}});
  for(let i=0;i<17;i++) console.log(delta);
}
if(prompt==='flood') for(let i=0;i<17;i++) console.log(JSON.stringify({type:'fixture',text:'x'.repeat(1024*1024)}));
if(prompt==='final-flood') { for(let i=0;i<15;i++) console.log(JSON.stringify({type:'fixture',text:'x'.repeat(1024*1024)})); await Bun.write(state,JSON.stringify(header)+'\\n'); const big = {role:'assistant',content:[{type:'text',text:'x'.repeat(2*1024*1024)}],stopReason:'stop'}; console.log(JSON.stringify({type:'agent_end',messages:[big],willRetry:false})); process.exit(0); }
const message = {role:'assistant',content:[{type:'text',text:prior?'続きも完了しました':'완료했습니다'}],stopReason:prompt==='failed'?'error':prompt==='length'?'length':'stop'};
console.log(JSON.stringify({type:'message_end',message}));
if(prompt==='malformed') console.log('{"type":');
if(prompt!=='no-terminal') console.log(JSON.stringify({type:'agent_end',messages:[{role:'custom',content:'hidden'},message],willRetry:prompt==='retry'}));
if(prompt==='nonzero') process.exit(3);
`

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'omo-runner-')))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'omo'), fakeOmo)
  await chmod(join(root, 'bin', 'omo'), 0o755)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function upstream(provider: CodingAgentProvider, status = 200) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe(
        provider === 'anthropic' ? '/v1/messages' : '/backend-api/codex/responses',
      )
      expect(request.headers.get('authorization')).toBe(`Bearer ${access}`)
      if (provider === 'openai-codex') expect(request.headers.get('chatgpt-account-id')).toBe('fixture-account')
      const body = await request.json()
      expect(body.model).toBe(provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-6-sol')
      return new Response(`data: ${JSON.stringify({ text: `${access} ${refresh} ${idToken}` })}\n\n`, {
        status,
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
}
const command = async (argv: readonly string[], env: Record<string, string>) => ({
  argv: [...argv],
  env: { ...DEFAULT_SANDBOX_ENV, PATH: `${root}/bin:/usr/bin:/bin`, ...env },
})

describe.skipIf(process.platform === 'win32')('OmO runner integration', () => {
  test.each(['anthropic', 'openai-codex'] as const)(
    'public lifecycle runs and resumes %s without child credentials',
    async (provider) => {
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
      await execute(
        ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'],
        source,
      )
      const before = await execute(['git', 'rev-parse', 'HEAD'], source)
      const server = upstream(provider)
      const brokers: CodingBroker[] = []
      const dependencies = {
        executor: () => execute,
        sourcePath: (path: string) => path,
        auth: async () => auth,
        writeArtifact: (path: string, text: string) => writeFile(path, text),
        run: (options: CodingRunOptions) =>
          runCodingAgent(options, {
            command,
            broker: async (options) => {
              const broker = await startCodingBroker(options, { upstream: new URL(server.url) })
              brokers.push(broker)
              return broker
            },
          }),
      }
      let service = new CodingAgentService(source, dependencies)
      const caller = {
        sessionId: 'parent',
        origin: { kind: 'tui' as const, sessionId: 'parent' },
        permissions: createPermissionService(),
      }
      try {
        const first = await service.execute(
          codingRequestSchema.parse({
            action: 'run',
            engine: 'omo',
            repo: source,
            modelRef: provider === 'anthropic' ? 'anthropic/claude-sonnet-4-6' : 'openai-codex/gpt-6-sol',
            prompt: '첫 작업',
          }),
          caller,
        )
        expect(first).toMatchObject({
          state: 'completed',
          engine: 'omo',
          provider,
          finalMessage: '완료했습니다',
          changedFiles: ['generated.txt'],
        })
        if (typeof first.worktreePath !== 'string') throw new Error('Missing worktree')
        const taskRoot = join(first.worktreePath, '..')
        await service.stop()
        service = new CodingAgentService(source, dependencies)
        const second = await service.execute(
          codingRequestSchema.parse({ action: 'run', engine: 'omo', taskId: first.taskId, prompt: '次の作業' }),
          caller,
        )
        expect(second).toMatchObject({
          state: 'completed',
          finalMessage: '続きも完了しました',
          provider,
          engineVersion: '5.1.19',
        })
        if (typeof second.patchPath !== 'string') throw new Error('Missing patch')
        expect(await readFile(second.patchPath, 'utf8')).toContain('次の作業')
        const observed = JSON.parse(await readFile(join(taskRoot, 'omo', 'agent', 'observed.json'), 'utf8'))
        expect(observed.prior).toContain('첫 작업')
        for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CHATGPT_ACCOUNT_ID'])
          expect(observed.env[name]).toBeUndefined()
        expect(observed.env.HOME).toBe(join(taskRoot, 'omo', 'home'))
        for (const file of await Array.fromAsync(
          new Bun.Glob('{omo,output}/**/*').scan({ cwd: taskRoot, onlyFiles: true, dot: true }),
        )) {
          const contents = await readFile(join(taskRoot, file), 'utf8')
          for (const canary of [access, refresh, idToken, ...brokers.map((b) => b.capability)])
            expect(contents).not.toContain(canary)
        }
        expect(await execute(['git', 'status', '--porcelain'], source)).toBe('')
        expect(await execute(['git', 'rev-parse', 'HEAD'], source)).toBe(before)
        expect(brokers[0]?.capability).not.toBe(brokers[1]?.capability)
        for (const broker of brokers) await expect(fetch(broker.baseUrl)).rejects.toThrow()
        const registry = JSON.parse(await readFile(join(source, '.typeclaw', 'coding-agent-tasks.json'), 'utf8'))
        expect(registry[0]).toMatchObject({
          provider,
          modelMetadata: { id: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-6-sol' },
        })
        expect(JSON.stringify(registry)).not.toContain(access)
        await rm(join(taskRoot, 'omo', 'sessions'), { recursive: true })
        const missing = await service.execute(
          codingRequestSchema.parse({ action: 'run', engine: 'omo', taskId: first.taskId, prompt: 'resume missing' }),
          caller,
        )
        expect(missing.state).toBe('incomplete')
        expect(missing.diagnostic).toContain('session')
        expect(brokers).toHaveLength(2)
        expect(
          await service.execute(
            codingRequestSchema.parse({ action: 'dispose', taskId: first.taskId, discard: true }),
            caller,
          ),
        ).toMatchObject({ state: 'disposed' })
      } finally {
        await service.stop()
        server.stop(true)
        await Promise.all(brokers.map((b) => b.close()))
      }
    },
  )

  test.each([
    ['no-terminal', 'incomplete'],
    ['length', 'incomplete'],
    ['retry', 'incomplete'],
    ['nonzero', 'failed'],
    ['failed', 'failed'],
    ['malformed', 'failed'],
    ['overflow', 'failed'],
    ['deltas', 'completed'],
    ['flood', 'failed'],
    ['final-flood', 'failed'],
    ['provider-error', 'failed'],
  ] as const)('preserves partial work and honest state on %s', async (prompt, state) => {
    for (const part of ['worktree', 'output']) await mkdir(join(root, part))
    const server = upstream('anthropic', prompt === 'provider-error' ? 400 : 200)
    const options: CodingRunOptions = {
      engine: 'omo',
      provider: 'anthropic',
      modelMetadata: omoModelSchema.parse(resolveModel('anthropic/claude-sonnet-4-6')),
      workspace: { source: root, taskRoot: root, baseSha: 'a'.repeat(40), sourceIdentity: 'fixture' },
      auth,
      model: 'claude-sonnet-4-6',
      allowedModels: ['claude-sonnet-4-6'],
      mode: 'code',
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt,
      timeoutSeconds: 10,
      writeArtifact: (path, text) => writeFile(path, text),
    }
    try {
      const result = await runCodingAgent(options, {
        command,
        broker: (opts) => startCodingBroker(opts, { upstream: new URL(server.url) }),
      })
      expect(result.state).toBe(state)
      if (prompt === 'flood' || prompt === 'final-flood') expect(result.diagnostic).toContain('16 MiB output limit')
      if (prompt === 'deltas') {
        const [jsonl] = (await readdir(join(root, 'output'))).filter((name) => name.endsWith('.jsonl'))
        expect(await readFile(join(root, 'output', jsonl!), 'utf8')).not.toContain('message_update')
      }
      if (prompt === 'failed' || prompt === 'provider-error') expect(result.exitCode).toBe(0)
      if (prompt !== 'provider-error')
        expect(await readFile(join(root, 'worktree', 'generated.txt'), 'utf8')).toBe(prompt)
      for (const output of await readdir(join(root, 'output'))) {
        const text = await readFile(join(root, 'output', output), 'utf8')
        for (const canary of [access, refresh, idToken]) expect(text).not.toContain(canary)
      }
    } finally {
      server.stop(true)
    }
  })

  test.each(['cancel', 'timeout', 'spawn'] as const)('revokes OmO capability on %s', async (kind) => {
    for (const part of ['worktree', 'output']) await mkdir(join(root, part))
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
    try {
      const running = runCodingAgent(
        {
          engine: 'omo',
          provider: 'anthropic',
          modelMetadata: omoModelSchema.parse(resolveModel('anthropic/claude-sonnet-4-6')),
          workspace: { source: root, taskRoot: root, baseSha: 'a'.repeat(40), sourceIdentity: 'fixture' },
          auth,
          model: 'claude-sonnet-4-6',
          allowedModels: ['claude-sonnet-4-6'],
          mode: 'code',
          sessionId: crypto.randomUUID(),
          resume: false,
          prompt: 'test',
          timeoutSeconds: kind === 'timeout' ? 0.1 : 10,
          signal: abort.signal,
          writeArtifact: (path, text) => writeFile(path, text),
        },
        {
          command: (argv, env) => command(kind === 'spawn' ? ['/no-such-omo-executable'] : argv, env),
          broker: async (options) => {
            broker = await startCodingBroker(options, { upstream: new URL(server.url) })
            return broker
          },
        },
      )
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
