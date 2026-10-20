import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionOrigin } from '@/agent/session-origin'
import type { AdapterId } from '@/channels/schema'
import { createPermissionService, rolesConfigSchema } from '@/permissions'

import { CodingAgentService, codingRequestSchema, type CodingCaller } from './index'

const origin = {
  kind: 'channel',
  adapter: 'slack-bot',
  workspace: 'T0123456789',
  chat: 'C0123456789',
  thread: null,
  lastInboundAuthorId: 'same-id',
} satisfies SessionOrigin

async function fixture(foreignNamespace?: AdapterId) {
  const dir = await mkdtemp(join(tmpdir(), 'coding-principal-'))
  const taskId = crypto.randomUUID()
  const permissions = createPermissionService({
    roles: rolesConfigSchema.parse({ owner: { match: ['slack:*'] } }),
  })
  const caller: CodingCaller = { sessionId: 'target-session', origin, permissions }
  const principal = [origin.adapter, origin.workspace, origin.chat, origin.thread, origin.lastInboundAuthorId]
  if (foreignNamespace !== undefined) principal.push(foreignNamespace)
  await mkdir(join(dir, '.typeclaw'))
  await writeFile(
    join(dir, '.typeclaw', 'coding-agent-tasks.json'),
    JSON.stringify([
      {
        taskId,
        ownerSessionId: caller.sessionId,
        principal: JSON.stringify(principal),
        role: 'owner',
        permissions: [...permissions.describe(origin).permissions],
        modelRef: 'anthropic/example-model',
        model: 'example-model',
        mode: 'code',
        allowedModels: [],
        engineVersion: 'example-version',
        source: dir,
        sourceIdentity: 'example-source',
        baseSha: 'example-base',
        state: 'completed',
        finalMessage: 'Private task result.',
      },
    ]),
  )
  const service = new CodingAgentService(dir)
  return {
    caller,
    service,
    taskId,
    async [Symbol.asyncDispose]() {
      await service.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

for (const action of ['result', 'run', 'dispose'] as const) {
  test(`foreign authors cannot ${action} a legacy task with an identical raw ID and session`, async () => {
    // Given: the old five-field principal belongs to a native Slack author.
    await using f = await fixture()
    const foreign: CodingCaller = { ...f.caller, origin: { ...origin, lastInboundAuthorAdapter: 'github' } }
    const request = codingRequestSchema.parse({
      action,
      taskId: f.taskId,
      ...(action === 'run' ? { engine: 'claude', prompt: 'Resume.' } : {}),
      ...(action === 'dispose' ? { discard: true } : {}),
    })
    expect(foreign.permissions.describe(foreign.origin)).toEqual(f.caller.permissions.describe(f.caller.origin))
    // When / Then
    await expect(f.service.execute(request, foreign)).rejects.toThrow('different caller or authority scope')
    // The denial does not revoke the legitimate native/shared-account owner.
    const shared: CodingCaller = { ...f.caller, origin: { ...origin, lastInboundAuthorAdapter: 'slack' } }
    expect((await f.service.execute({ action: 'result', taskId: f.taskId }, shared)).finalMessage).toBe(
      'Private task result.',
    )
  })
}

test('foreign task ownership shares only explicit account namespaces', async () => {
  // Given: a foreign Discord requester owns a task in this Slack session.
  await using f = await fixture('discord')
  const foreign: CodingCaller = { ...f.caller, origin: { ...origin, lastInboundAuthorAdapter: 'discord-bot' } }
  // When
  const result = await f.service.execute({ action: 'result', taskId: f.taskId }, foreign)
  // Then
  expect(result.finalMessage).toBe('Private task result.')
  await expect(f.service.execute({ action: 'result', taskId: f.taskId }, f.caller)).rejects.toThrow(
    'different caller or authority scope',
  )
})
