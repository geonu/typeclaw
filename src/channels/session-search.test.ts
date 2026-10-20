import { expect, test } from 'bun:test'

import { rolesConfigSchema } from '@/permissions'

import { handoffFixture, inbound, sourceKey, targetKey } from './session-handoff.fixture'

for (const query of ['개발', '배포 확인', '민수', 'ALICE']) {
  test(`search matches names, consumed messages and participants for ${query}`, async () => {
    // Given
    await using f = await handoffFixture()
    f.router.registerChannelNameResolver('discord-bot', async () => ({ chatName: '개발 지원' }))
    await f.receive(inbound(targetKey, { text: '배포 확인 부탁합니다', authorName: '민수' }))
    await f.receive(inbound(targetKey, { text: 'A newer message.', authorId: 'bob', authorName: 'Bob' }))
    await f.receive(inbound(sourceKey))
    // When
    const targets = f.router.searchSessions({ fromSessionId: f.session(sourceKey).id, query })
    // Then
    expect(targets).toHaveLength(1)
    expect(targets[0]).toEqual({
      target: targetKey,
      name: '개발 지원',
      activity: 'A newer message.',
      lastActiveAt: 1000,
    })
    expect(
      (
        await f.router.handoff({
          fromSessionId: f.session(sourceKey).id,
          target: targets[0]?.target ?? sourceKey,
          text: 'Continue here.',
        })
      ).ok,
    ).toBe(true)
    await f.flush(targetKey)
  })
}

test('foreign author-specific grants do not disclose sessions even after a local-role cache hit', async () => {
  // Given
  await using f = await handoffFixture({
    roles: rolesConfigSchema.parse({ owner: { match: ['discord:* author:alice', 'slack:* author:alice'] } }),
  })
  const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
  await f.receive(inbound(targetKey, { text: 'Secret target discussion.' }))
  await f.receive(inbound(foreign))
  // When
  const targets = f.router.searchSessions({ fromSessionId: f.session(foreign).id, query: 'Secret' })
  // Then
  expect(targets).toEqual([])
})

test('authorless foreign matches are discoverable only without elevation', async () => {
  // Given
  await using f = await handoffFixture({
    roles: rolesConfigSchema.parse({
      owner: { match: ['discord:guild/private'] },
      member: { match: ['discord:*', 'slack:*'] },
    }),
  })
  const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
  await f.receive(inbound(targetKey, { text: 'Searchable project.' }))
  await f.receive(inbound({ ...targetKey, chat: 'private' }, { text: 'Searchable secret.' }))
  await f.receive(inbound(foreign))
  // When
  const targets = f.router.searchSessions({ fromSessionId: f.session(foreign).id, query: 'Searchable' })
  // Then
  expect(targets.map((entry) => entry.target)).toEqual([targetKey])
})

test('search reevaluates target grants instead of caching eligibility', async () => {
  // Given
  await using f = await handoffFixture()
  await f.receive(inbound(targetKey))
  await f.receive(inbound(sourceKey))
  const fromSessionId = f.session(sourceKey).id
  expect(f.router.searchSessions({ fromSessionId, query: 'target' })).toHaveLength(1)
  f.permissions.replaceRoles(rolesConfigSchema.parse({ member: { match: ['discord:guild/source'] } }))
  // When
  const targets = f.router.searchSessions({ fromSessionId, query: 'target' })
  // Then
  expect(targets).toEqual([])
})

test('read-address filtering never links equal conversation IDs on different platforms', async () => {
  // Given
  await using f = await handoffFixture({
    roles: rolesConfigSchema.parse({ member: { match: ['discord:*', 'slack:*'] } }),
  })
  await f.receive(inbound(targetKey))
  await f.receive(inbound({ ...targetKey, adapter: 'slack-bot' }))
  await f.receive(inbound(sourceKey))
  // When
  const targets = f.router.searchSessions({
    fromSessionId: f.session(sourceKey).id,
    query: '',
    conversation: { ...targetKey, adapter: 'discord' },
  })
  // Then
  expect(targets.map((entry) => entry.target)).toEqual([targetKey])
})
