import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPermissionService } from '@/permissions'
import { rolesConfigSchema } from '@/permissions/schema'

import { CodingAgentService, codingRequestSchema, type CodingCaller } from './index'
import type { CodingRunResult } from './runner'
import { runCodingProcess } from './worktree'

let root: string
let caller: CodingCaller
let service: CodingAgentService
const result: CodingRunResult = {
  state: 'completed',
  finalMessage: '검증 완료',
  exitCode: 0,
  diagnostic: '',
  sessionId: crypto.randomUUID(),
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coding-service-')))
  await local(['git', 'init', root], root)
  await writeFile(join(root, 'code.txt'), 'base\n')
  await local(['git', 'add', '.'], root)
  await local(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], root)
  caller = {
    sessionId: 'operator-session',
    origin: {
      kind: 'subagent',
      subagent: 'operator',
      parentSessionId: 'parent',
      spawnedByRole: 'owner',
      spawnedByOrigin: { kind: 'tui', sessionId: 'parent' },
    },
    permissions: createPermissionService(),
  }
})
afterEach(async () => {
  await service?.stop()
  await rm(root, { recursive: true, force: true })
})
const local = (argv: readonly string[], cwd: string, env?: Record<string, string>) =>
  runCodingProcess(argv, cwd, {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    ...env,
  })
function makeService(run: () => Promise<CodingRunResult> = async () => result) {
  return new CodingAgentService(root, {
    executor: () => local,
    run,
    sourcePath: (source) => source,
    auth: async () => ({ resolve: async () => ({ type: 'api_key', token: 'fixture', secrets: ['fixture'] }) }),
    writeArtifact: (path, text) => writeFile(path, text),
  })
}
const runRequest = () =>
  codingRequestSchema.parse({
    action: 'run',
    engine: 'claude',
    repo: root,
    modelRef: 'anthropic/claude-opus-5-5',
    prompt: '테스트',
  })
function idOf(receipt: Record<string, unknown>): string {
  if (typeof receipt.taskId !== 'string') throw new Error('Missing task ID')
  return receipt.taskId
}

// These scenarios exercise the real POSIX Git/shell snapshot and artifact pipeline.
describe.skipIf(process.platform === 'win32')('coding task authority', () => {
  test('parent reads operator results while siblings and changed channel principals cannot', async () => {
    service = makeService()
    const receipt = await service.execute(runRequest(), caller)
    expect(receipt).toHaveProperty('warning')
    const taskId = idOf(receipt)
    const get = codingRequestSchema.parse({ action: 'result', taskId })
    expect(
      (await service.execute(get, { ...caller, sessionId: 'parent', origin: { kind: 'tui', sessionId: 'parent' } }))
        .state,
    ).toBe('completed')
    await expect(service.execute(get, { ...caller, sessionId: 'sibling' })).rejects.toThrow('scope')
    await expect(
      service.execute(get, {
        ...caller,
        origin: {
          kind: 'channel',
          adapter: 'slack',
          workspace: 'T0123456789',
          chat: 'C0123456789',
          thread: null,
          lastInboundAuthorId: 'other',
        },
      }),
    ).rejects.toThrow()
    await expect(service.execute(get, { ...caller, origin: undefined })).rejects.toThrow()
    const persisted = await readFile(join(root, '.typeclaw', 'coding-agent-tasks.json'), 'utf8')
    expect(persisted).not.toContain('fixture')
    // Model-writable artifact cannot rewrite the ownership or result.
    await writeFile(join(root, 'workspace', 'coding-agents', taskId, 'output', 'result.json'), '{"state":"forged"}')
    expect((await service.execute(get, caller)).state).toBe('completed')
  })

  test('serializes resumes and disposal while distinct tasks remain independent', async () => {
    let release: (value: CodingRunResult) => void = () => {}
    let entered: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let turn = 0
    service = makeService(async () => {
      turn++
      if (turn === 2) {
        entered()
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return result
    })
    const taskId = idOf(await service.execute(runRequest(), caller))
    const resume = codingRequestSchema.parse({ action: 'run', engine: 'claude', taskId, prompt: 'continue' })
    const running = service.execute(resume, caller)
    await started
    try {
      await expect(service.execute(resume, caller)).rejects.toThrow('already running')
      await expect(
        service.execute(codingRequestSchema.parse({ action: 'dispose', taskId, discard: true }), caller),
      ).rejects.toThrow('already running')
      const other = await service.execute(runRequest(), caller)
      expect(other.taskId).not.toBe(taskId)
    } finally {
      release(result)
      await running
    }
    await expect(
      service.execute(codingRequestSchema.parse({ action: 'dispose', taskId, discard: true }), caller),
    ).resolves.toMatchObject({ state: 'disposed' })
  })

  test('restart marks running tasks interrupted and resumes the recorded session', async () => {
    service = makeService()
    const taskId = idOf(await service.execute(runRequest(), caller))
    await service.stop()
    const path = join(root, '.typeclaw', 'coding-agent-tasks.json')
    const records = JSON.parse(await readFile(path, 'utf8'))
    records[0].state = 'running'
    await writeFile(path, JSON.stringify(records))
    service = makeService()
    expect((await service.execute(codingRequestSchema.parse({ action: 'result', taskId }), caller)).state).toBe(
      'interrupted',
    )
    expect(
      (
        await service.execute(
          codingRequestSchema.parse({ action: 'run', engine: 'claude', taskId, prompt: 'continue' }),
          caller,
        )
      ).state,
    ).toBe('completed')
  })

  test('rejects Codex without touching authentication and preserves other tool work', async () => {
    service = new CodingAgentService(root, {
      auth: async () => {
        throw new Error('must not resolve')
      },
    })
    expect(
      await service.execute(codingRequestSchema.parse({ action: 'run', engine: 'codex', prompt: 'test' }), caller),
    ).toMatchObject({ ok: false })
    expect(await local(['/bin/sh', '-c', 'printf ordinary-command'], root)).toBe('ordinary-command')
  })

  test('missing Claude auth affects only its task and can be repaired', async () => {
    let missing = true
    service = new CodingAgentService(root, {
      executor: () => local,
      sourcePath: (source) => source,
      run: async () => result,
      writeArtifact: (path, text) => writeFile(path, text),
      auth: async () => ({
        resolve: async () => {
          if (missing) throw new Error('Missing fixture auth')
          return { type: 'api_key', token: 'fixture', secrets: ['fixture'] }
        },
      }),
    })
    await expect(service.execute(runRequest(), caller)).rejects.toThrow('Missing fixture auth')
    await mkdir(join(root, 'ordinary-output'))
    missing = false
    expect((await service.execute(runRequest(), caller)).state).toBe('completed')
  })

  test('same channel session cannot transfer a task to another permitted speaker or a downgraded role', async () => {
    service = makeService()
    const permissions = createPermissionService({
      roles: rolesConfigSchema.parse({ owner: { match: ['slack:*'] } }),
    })
    const channelCaller: CodingCaller = {
      sessionId: 'shared-channel',
      permissions,
      origin: {
        kind: 'channel',
        adapter: 'slack-bot',
        workspace: 'T0123456789',
        chat: 'C0123456789',
        thread: null,
        lastInboundAuthorId: 'alice',
      },
    }
    const taskId = idOf(await service.execute(runRequest(), channelCaller))
    const request = codingRequestSchema.parse({ action: 'result', taskId })
    if (channelCaller.origin?.kind !== 'channel') throw new Error('Invalid fixture')
    await expect(
      service.execute(request, {
        ...channelCaller,
        origin: { ...channelCaller.origin, lastInboundAuthorId: 'bob' },
      }),
    ).rejects.toThrow('scope')
    permissions.replaceRoles(rolesConfigSchema.parse({ member: { match: ['slack:*'] } }))
    await expect(service.execute(request, channelCaller)).rejects.toThrow()
  })

  test('plan resumes stay read-only until an explicit authorized code transition', async () => {
    const modes: string[] = []
    service = new CodingAgentService(root, {
      executor: () => local,
      sourcePath: (source) => source,
      writeArtifact: (path, text) => writeFile(path, text),
      auth: async () => ({ resolve: async () => ({ type: 'api_key', token: 'fixture', secrets: ['fixture'] }) }),
      run: async (options) => {
        modes.push(options.mode)
        return result
      },
    })
    const taskId = idOf(await service.execute(codingRequestSchema.parse({ ...runRequest(), mode: 'plan' }), caller))
    await service.execute(
      codingRequestSchema.parse({ action: 'run', engine: 'claude', taskId, prompt: 'continue' }),
      caller,
    )
    await service.execute(
      codingRequestSchema.parse({ action: 'run', engine: 'claude', taskId, prompt: 'implement', mode: 'code' }),
      caller,
    )
    expect(modes).toEqual(['plan', 'plan', 'code'])
  })
})
