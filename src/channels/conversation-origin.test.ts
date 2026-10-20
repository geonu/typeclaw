import { expect, test } from 'bun:test'

import { rolesConfigSchema } from '@/permissions'

import { handoffFixture, inbound, sourceKey, targetKey } from './session-handoff.fixture'

test('a conversation origin hint crosses account adapters without requiring a DM', async () => {
  // Given
  await using f = await handoffFixture()
  await f.receive(inbound(targetKey))
  // When
  await f.receive(inbound(sourceKey))
  await f.receive(inbound(sourceKey))
  // Then: machine-consumed target coordinates appear once, not on every turn.
  const prompts = f.session(sourceKey).prompts
  expect(prompts[0]).toContain('adapter="discord-bot" workspace="guild" chat="target"')
  expect(prompts[1]).not.toContain('chat="target"')
})

test('origin hints never link equal author IDs across platform namespaces', async () => {
  // Given
  await using f = await handoffFixture({
    roles: rolesConfigSchema.parse({ member: { match: ['discord:*', 'slack:*'] } }),
  })
  await f.receive(inbound(targetKey))
  const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
  // When
  await f.receive(inbound(foreign))
  // Then
  expect(f.session(foreign).prompts[0]).not.toContain('chat="target"')
})

test('origin hints omit a recently visited target that would elevate authority', async () => {
  // Given
  await using f = await handoffFixture({
    roles: rolesConfigSchema.parse({
      owner: { match: ['discord:guild/target'] },
      member: { match: ['discord:guild/source'] },
    }),
  })
  await f.receive(inbound(targetKey))
  // When
  await f.receive(inbound(sourceKey))
  // Then
  expect(f.session(sourceKey).prompts[0]).not.toContain('chat="target"')
})
