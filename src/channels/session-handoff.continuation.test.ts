import { expect, test } from 'bun:test'

import { rolesConfigSchema } from '@/permissions'

import { BackgroundObligationStore } from './background-obligations'
import { handoffFixture, inbound, sourceKey, targetKey } from './session-handoff.fixture'

test('background work retains the authenticated foreign principal in durable storage', async () => {
  // Given
  await using f = await handoffFixture({
    roles: rolesConfigSchema.parse({
      owner: { match: ['discord:* author:alice'] },
      member: { match: ['discord:*', 'slack:*'] },
    }),
  })
  const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
  await f.receive(inbound(targetKey, { authorId: 'bob' }))
  await f.receive(inbound(foreign))
  f.session(targetKey).onPrompt = async () => {
    await f.router.acceptBackgroundResponse({
      parentSessionId: f.session(targetKey).id,
      key: targetKey,
      taskId: 'example-task',
      subagentName: 'worker',
      startedAt: f.clock.now,
      accountIdentity: 'discord-bot-account',
      triggeringAuthorId: 'alice',
    })
  }
  // When
  await f.router.handoff({ fromSessionId: f.session(foreign).id, target: targetKey, text: 'Delegate this work.' })
  await f.flush(targetKey)
  const restored = new BackgroundObligationStore(f.agentDir)
  const row = await restored.lookup(f.session(targetKey).id, 'example-task')
  // Then: reloading durable state must not turn foreign Alice into local owner Alice.
  expect(row?.principal).toMatchObject({ lastInboundAuthorId: 'alice', lastInboundAuthorAdapter: 'slack-bot' })
  if (row?.principal.kind !== 'channel') throw new Error('expected persisted channel principal')
  expect(f.permissions.resolveRole({ ...row.principal, thread: null })).toBe('member')
})
