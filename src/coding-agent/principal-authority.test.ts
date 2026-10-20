import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { z } from 'zod'

import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService } from '@/permissions'
import { rolesConfigSchema } from '@/permissions/schema'

import { CodingAgentService, codingRequestSchema, type CodingCaller } from './index'
import type { CodingRunResult } from './runner'
import { runCodingProcess } from './worktree'

let root: string
let service: CodingAgentService
const completed: CodingRunResult = {
  state: 'completed',
  finalMessage: 'Private task result',
  exitCode: 0,
  diagnostic: '',
  sessionId: crypto.randomUUID(),
}
const permissions = createPermissionService({
  roles: rolesConfigSchema.parse({ owner: { match: ['*'] } }),
})
const local = (argv: readonly string[], cwd: string, env?: Record<string, string>) =>
  runCodingProcess(argv, cwd, {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    GIT_MASTER: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...env,
  })
function makeService() {
  return new CodingAgentService(root, {
    executor: () => local,
    sourcePath: (source) => source,
    run: async () => completed,
    auth: async () => ({
      resolve: async () => ({ provider: 'anthropic', type: 'api_key', token: 'fixture', secrets: ['fixture'] }),
    }),
    writeArtifact: (path, text) => writeFile(path, text),
  })
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'coding-principal-')))
  await local(['git', 'init', root], root)
  await writeFile(join(root, 'code.txt'), 'base\n')
  await local(['git', 'add', '.'], root)
  await local(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'], root)
  service = makeService()
})
afterEach(async () => {
  await service?.stop()
  await rm(root, { recursive: true, force: true })
})

const cases = [
  {
    name: 'foreign collision',
    adapter: 'slack-bot',
    owner: 'slack-bot',
    author: 'github',
    legacy: false,
    allowed: false,
  },
  {
    name: 'legacy foreign collision',
    adapter: 'slack-bot',
    owner: 'slack-bot',
    author: 'github',
    legacy: true,
    allowed: false,
  },
  {
    name: 'legacy local owner',
    adapter: 'slack-bot',
    owner: 'slack-bot',
    author: 'slack-bot',
    legacy: true,
    allowed: true,
  },
  {
    name: 'legacy sibling owner',
    adapter: 'slack-bot',
    owner: 'slack-bot',
    author: 'slack',
    legacy: true,
    allowed: true,
  },
  {
    name: 'Slack sibling owner',
    adapter: 'slack-bot',
    owner: 'slack-bot',
    author: 'slack',
    legacy: false,
    allowed: true,
  },
  {
    name: 'Discord sibling owner',
    adapter: 'discord-bot',
    owner: 'discord-bot',
    author: 'discord',
    legacy: false,
    allowed: true,
  },
  {
    name: 'Webex sibling owner',
    adapter: 'webex-bot',
    owner: 'webex-bot',
    author: 'webex',
    legacy: false,
    allowed: true,
  },
  { name: 'foreign task owner', adapter: 'slack-bot', owner: 'github', author: 'github', legacy: false, allowed: true },
  {
    name: 'local collision with foreign task',
    adapter: 'slack-bot',
    owner: 'github',
    author: 'slack-bot',
    legacy: false,
    allowed: false,
  },
] as const

// Real registry reload, Git worktree, result, resume and disposal paths; only
// the credential provider and external coding CLI are replaced.
describe.skipIf(process.platform === 'win32')('coding principal namespaces', () => {
  for (const delegated of [false, true]) {
    for (const action of ['result', 'run', 'dispose'] as const) {
      test.each([...cases])(`$name: ${action}, delegated=${delegated}`, async (scenario) => {
        // Given identical target coordinates, raw author IDs and permissions.
        const ownerOrigin: SessionOrigin = {
          kind: 'channel',
          adapter: scenario.adapter,
          workspace: 'workspace',
          chat: 'conversation',
          thread: null,
          lastInboundAuthorId: 'U0123456789',
          ...(scenario.owner !== scenario.adapter ? { lastInboundAuthorAdapter: scenario.owner } : {}),
        }
        const owner: CodingCaller = {
          sessionId: 'target-session',
          origin: ownerOrigin,
          permissions,
        }
        const created = await service.execute(
          codingRequestSchema.parse({
            action: 'run',
            engine: 'claude',
            repo: root,
            modelRef: 'anthropic/claude-opus-5-5',
            prompt: 'Create owner task',
          }),
          owner,
        )
        expect(created.state).toBe('completed')
        const taskId = z.string().parse(created.taskId)
        await service.stop()
        if (scenario.legacy) {
          const path = join(root, '.typeclaw', 'coding-agent-tasks.json')
          const records = z
            .array(z.looseObject({ principal: z.string() }))
            .parse(JSON.parse(await readFile(path, 'utf8')))
          for (const record of records) {
            record.principal = JSON.stringify([
              ownerOrigin.adapter,
              ownerOrigin.workspace,
              ownerOrigin.chat,
              ownerOrigin.thread,
              ownerOrigin.lastInboundAuthorId,
            ])
          }
          await writeFile(path, JSON.stringify(records))
        }
        service = makeService()
        const channelOrigin: SessionOrigin = { ...ownerOrigin, lastInboundAuthorAdapter: scenario.author }
        const requester: CodingCaller = {
          ...owner,
          origin: delegated
            ? {
                kind: 'subagent',
                subagent: 'operator',
                parentSessionId: owner.sessionId,
                spawnedByRole: 'owner',
                spawnedByOrigin: channelOrigin,
              }
            : channelOrigin,
        }
        expect(permissions.describe(requester.origin).permissions).toEqual(
          permissions.describe(owner.origin).permissions,
        )
        const requests = {
          result: { action: 'result', taskId },
          run: { action: 'run', engine: 'claude', taskId, prompt: 'Resume owner task' },
          dispose: { action: 'dispose', taskId, discard: true },
        } as const
        const request = codingRequestSchema.parse(requests[action])

        // When
        const execution = service.execute(request, requester)

        // Then
        if (scenario.allowed) {
          await expect(execution).resolves.toMatchObject({
            taskId,
            state: action === 'dispose' ? 'disposed' : 'completed',
          })
        } else {
          await expect(execution).rejects.toThrow('different caller or authority scope')
          await expect(
            service.execute(codingRequestSchema.parse({ action: 'result', taskId }), owner),
          ).resolves.toMatchObject({
            state: 'completed',
            finalMessage: completed.finalMessage,
          })
        }
      })
    }
  }
})
