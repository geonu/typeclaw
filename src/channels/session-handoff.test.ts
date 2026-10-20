import { describe, expect, test } from 'bun:test'

import { createChannelReplyTool } from '@/agent/tools/channel-reply'
import { rolesConfigSchema } from '@/permissions'

import type { ChannelHandoffResult } from './session-handoff'
import { handoffFixture, inbound, sourceKey, targetKey } from './session-handoff.fixture'
import { channelKeyId } from './types'

describe('cross-adapter handoff', () => {
  test('delivers through the target bot identity without reply anchors', async () => {
    // Given: only Bob spoke in the target; Alice requested work in a user-account session.
    await using f = await handoffFixture()
    await f.receive(inbound(targetKey, { authorId: 'bob', authorName: 'Bob' }))
    await f.receive(inbound(sourceKey))
    f.session(targetKey).onPrompt = async () => {
      const tool = createChannelReplyTool({ router: f.router, origin: targetKey, sessionId: f.session(targetKey).id })
      await tool.execute(
        'reply',
        { text: 'Completed in the owning conversation.', continue_after_reply: false },
        undefined,
        undefined,
        f.session(targetKey).context,
      )
    }
    // When
    const result = await f.router.handoff({
      fromSessionId: f.session(sourceKey).id,
      target: targetKey,
      text: 'Do the work.',
    })
    await f.flush(targetKey)
    // Then
    expect(result).toEqual({ ok: true, target: channelKeyId(targetKey) })
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({ adapter: 'discord-bot', chat: 'target' })
    expect(f.sent[0]?.replyTo).toBeUndefined()
    expect(f.session(targetKey).origin.current).toMatchObject({
      lastInboundAuthorId: 'alice',
      lastInboundAuthorAdapter: 'discord',
    })
  })

  test('refuses a foreign author whose raw ID matches a privileged target author', async () => {
    // Given
    await using f = await handoffFixture({
      roles: rolesConfigSchema.parse({ owner: { match: ['discord:* author:alice', 'slack:* author:alice'] } }),
    })
    const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
    await f.receive(inbound(targetKey))
    await f.receive(inbound(foreign))
    // When
    const result = await f.router.handoff({ fromSessionId: f.session(foreign).id, target: targetKey, text: '/help' })
    // Then
    expect(result).toMatchObject({ ok: false, code: 'requester-unknown-in-target' })
    expect(f.session(targetKey).prompts).toHaveLength(1)
    expect(f.sent).toEqual([])
    expect(f.logs.some((line) => line.includes('requester-unknown-in-target'))).toBe(true)
  })

  test('a foreign authorless grant stays bounded during the actual target turn', async () => {
    // Given
    await using f = await handoffFixture({
      roles: rolesConfigSchema.parse({
        owner: { match: ['discord:* author:alice'] },
        member: { match: ['slack:*', 'discord:*'] },
      }),
    })
    const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
    await f.receive(inbound(targetKey, { authorId: 'bob' }))
    await f.receive(inbound(foreign))
    // When
    const result = await f.router.handoff({
      fromSessionId: f.session(foreign).id,
      target: targetKey,
      text: 'Handle this.',
    })
    await f.flush(targetKey)
    // Then: the coincident local Alice owner grant never applies.
    expect(result.ok).toBe(true)
    expect(f.permissions.resolveRole(f.session(targetKey).origin.current)).toBe('member')
    expect(f.session(targetKey).origin.current).toMatchObject({ lastInboundAuthorAdapter: 'slack-bot' })
  })

  test('refuses an elevating authorless foreign grant even for a recent participant', async () => {
    // Given
    await using f = await handoffFixture({
      roles: rolesConfigSchema.parse({ owner: { match: ['discord:*'] }, member: { match: ['slack:*'] } }),
    })
    const foreign = { ...sourceKey, adapter: 'slack-bot' as const }
    await f.receive(inbound(targetKey))
    await f.receive(inbound(foreign))
    // When
    const result = await f.router.handoff({
      fromSessionId: f.session(foreign).id,
      target: targetKey,
      text: 'Escalate.',
    })
    // Then
    expect(result).toMatchObject({ ok: false, code: 'would-elevate' })
    expect(f.sent).toEqual([])
  })

  for (const role of ['owner', 'member'] as const) {
    test(`${role} can hand off after the participation window expires`, async () => {
      // Given
      await using f = await handoffFixture({ roles: rolesConfigSchema.parse({ [role]: { match: ['discord:*'] } }) })
      await f.receive(inbound(targetKey))
      f.clock.now += 31 * 60_000
      await f.receive(inbound(sourceKey))
      // When
      const result = await f.router.handoff({
        fromSessionId: f.session(sourceKey).id,
        target: targetKey,
        text: 'Continue.',
      })
      await f.flush(targetKey)
      // Then
      expect(result.ok).toBe(true)
      expect(f.session(targetKey).prompts.at(-1)).toContain('Continue.')
    })
  }

  test('context-only handling and loop refusal survive the adapter boundary', async () => {
    // Given
    const claims: string[] = []
    await using f = await handoffFixture({
      claimHandler: async (input) => {
        claims.push(input.text)
        return { kind: 'consumed', reply: 'claimed' }
      },
    })
    await f.receive(inbound(targetKey))
    await f.receive(inbound(sourceKey))
    let nested: ChannelHandoffResult | undefined
    f.session(targetKey).onPrompt = async () => {
      nested = await f.router.handoff({ fromSessionId: f.session(targetKey).id, target: sourceKey, text: 'Loop.' })
    }
    // When
    const result = await f.router.handoff({
      fromSessionId: f.session(sourceKey).id,
      target: targetKey,
      text: '/help claim-7K9M-2X3R',
    })
    await f.flush(targetKey)
    // Then
    expect(result.ok).toBe(true)
    expect(f.session(targetKey).prompts.at(-1)).toContain('/help claim-7K9M-2X3R')
    expect(nested).toMatchObject({ ok: false, code: 'loop' })
    expect(claims).toEqual([])
    expect(f.sent).toEqual([])
  })

  test('rechecks changed target roles and keeps refusals off channels', async () => {
    // Given
    await using f = await handoffFixture()
    await f.receive(inbound(targetKey))
    await f.receive(inbound(sourceKey))
    f.permissions.replaceRoles(rolesConfigSchema.parse({ member: { match: ['discord:guild/source'] } }))
    // When
    const result = await f.router.handoff({
      fromSessionId: f.session(sourceKey).id,
      target: targetKey,
      text: 'Continue.',
    })
    // Then
    expect(result).toMatchObject({ ok: false, code: 'requester-unknown-in-target' })
    expect(f.sent).toEqual([])
  })
})
