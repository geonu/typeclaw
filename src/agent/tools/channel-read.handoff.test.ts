import { expect, test } from 'bun:test'

import { buildChannelTools } from '@/agent'
import { handoffFixture, inbound, sourceKey, targetKey } from '@/channels/session-handoff.fixture'
import { rolesConfigSchema } from '@/permissions'

for (const mode of ['history', 'message'] as const) {
  for (const targetExists of [true, false]) {
    test(`${mode} Missing Access suggests handoff only when a target exists (${targetExists})`, async () => {
      // Given
      await using f = await handoffFixture()
      if (targetExists) await f.receive(inbound(targetKey))
      await f.receive(inbound(sourceKey))
      f.router.registerHistory('discord', async () => ({ ok: false, error: 'Missing Access' }))
      f.router.registerMessageGet('discord', async () => ({ ok: false, error: 'Missing Access' }))
      const session = f.session(sourceKey)
      const tool = buildChannelTools(f.router, { kind: 'channel', ...sourceKey }, session.id).find(
        (candidate) => candidate.name === 'channel_read',
      )
      if (tool === undefined) throw new Error('missing channel_read')
      // When
      const result = await tool.execute(
        'read',
        {
          mode,
          adapter: 'discord',
          workspace: 'guild',
          chat: 'target',
          message_id: 'message',
        },
        undefined,
        undefined,
        session.context,
      )
      // Then
      expect(result.details).toMatchObject({ ok: false, error: 'Missing Access' })
      if (targetExists) {
        expect(result.details).toMatchObject({ handoffTargets: [targetKey] })
        expect(result.content.some((part) => part.type === 'text' && part.text.includes('channel_handoff'))).toBe(true)
      } else {
        expect(result.details).not.toHaveProperty('handoffTargets')
        expect(result.content.some((part) => part.type === 'text' && part.text.includes('channel_handoff'))).toBe(false)
      }
      expect(f.sent).toEqual([])
    })
  }
}

test('an access error never reveals a target whose role no longer matches', async () => {
  // Given
  await using f = await handoffFixture()
  await f.receive(inbound(targetKey))
  await f.receive(inbound(sourceKey))
  f.permissions.replaceRoles(rolesConfigSchema.parse({ member: { match: ['discord:guild/source'] } }))
  f.router.registerHistory('discord', async () => ({ ok: false, error: 'Missing Access' }))
  const session = f.session(sourceKey)
  const tool = buildChannelTools(f.router, { kind: 'channel', ...sourceKey }, session.id).find(
    (candidate) => candidate.name === 'channel_read',
  )
  if (tool === undefined) throw new Error('missing channel_read')
  // When
  const result = await tool.execute(
    'read',
    {
      mode: 'history',
      adapter: 'discord',
      workspace: 'guild',
      chat: 'target',
    },
    undefined,
    undefined,
    session.context,
  )
  // Then
  expect(result.details).not.toHaveProperty('handoffTargets')
})

test('a transient read failure does not suggest a handoff', async () => {
  // Given
  await using f = await handoffFixture()
  await f.receive(inbound(targetKey))
  await f.receive(inbound(sourceKey))
  f.router.registerHistory('discord', async () => ({ ok: false, error: 'Connection reset' }))
  const session = f.session(sourceKey)
  const tool = buildChannelTools(f.router, { kind: 'channel', ...sourceKey }, session.id).find(
    (candidate) => candidate.name === 'channel_read',
  )
  if (tool === undefined) throw new Error('missing channel_read')
  // When
  const result = await tool.execute(
    'read',
    {
      mode: 'history',
      adapter: 'discord',
      workspace: 'guild',
      chat: 'target',
    },
    undefined,
    undefined,
    session.context,
  )
  // Then
  expect(result.details).toEqual({ ok: false, error: 'Connection reset' })
})
