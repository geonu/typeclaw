import { describe, expect, test } from 'bun:test'

import type { DiscordGatewayMessageCreateEvent } from 'agent-messenger/discordbot'

import { defaultHistoryConfig, type ChannelAdapterConfig } from '@/channels/schema'

import { classifyInbound } from './discord-bot-classify'
import { encodeDiscordReactionRef } from './discord-bot-reactions'

const BOT_USER_ID = '999'

const baseConfig: ChannelAdapterConfig = {
  enabled: true,
  engagement: {
    trigger: ['mention', 'reply', 'dm'],
    stickiness: { perReply: { window: 300_000 } },
  },
  history: defaultHistoryConfig(),
}

function buildEvent(overrides: Partial<DiscordGatewayMessageCreateEvent> = {}): DiscordGatewayMessageCreateEvent {
  return {
    type: 'MESSAGE_CREATE',
    id: 'm1',
    channel_id: 'c1',
    guild_id: 'g1',
    author: { id: 'u1', username: 'alice', bot: false },
    content: 'hello',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('classifyInbound — drop paths', () => {
  test('drops self-authored messages (author.id === botUserId) with reason=self_author', () => {
    const event = buildEvent({ author: { id: BOT_USER_ID, username: 'me', bot: true } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'self_author' })
  })

  test('drops empty-content messages with reason=empty_content (missing MessageContent intent)', () => {
    const event = buildEvent({ content: '' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'empty_content' })
  })

  test('routes media-only messages with attachment metadata instead of treating them as missing intent', () => {
    const event = buildEvent({
      content: '',
      attachments: [
        {
          id: 'a1',
          filename: 'diagram.png',
          size: 1234,
          url: 'https://cdn.discordapp.com/attachments/c1/a1/diagram.png',
          content_type: 'image/png',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Discord attachment #1: file image/png name=diagram.png]')
    expect(verdict.payload.attachments).toEqual([
      {
        id: 1,
        kind: 'file',
        ref: 'https://cdn.discordapp.com/attachments/c1/a1/diagram.png',
        filename: 'diagram.png',
        mimetype: 'image/png',
      },
    ])
  })

  test('routes sticker-only messages because Discord exposes sticker metadata without MessageContent intent', () => {
    const event = buildEvent({
      content: '',
      sticker_items: [{ id: 's1', name: 'party parrot', format_type: 1 }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Discord attachment #1: sticker name=party parrot]')
    expect(verdict.payload.attachments).toEqual([{ id: 1, kind: 'sticker', ref: '', filename: 'party parrot' }])
  })

  test('routes embed-only messages with embed metadata when Discord provides it', () => {
    const event = buildEvent({
      content: '',
      embeds: [{ type: 'rich', title: 'Release notes', url: 'https://example.com/releases' }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('[Discord attachment #1: embed name=Release notes]')
    expect(verdict.payload.attachments).toEqual([
      { id: 1, kind: 'embed', ref: 'https://example.com/releases', filename: 'Release notes' },
    ])
  })

  test('appends attachment summary to user content so the agent sees BOTH text and the file when the user typed something alongside an upload', () => {
    const event = buildEvent({
      content: 'look at this',
      attachments: [
        {
          id: 'a1',
          filename: 'diagram.png',
          size: 1234,
          url: 'https://cdn.discordapp.com/attachments/c1/a1/diagram.png',
          content_type: 'image/png',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe('look at this\n[Discord attachment #1: file image/png name=diagram.png]')
  })

  test('appends multiple attachments separated by `;` so each file ref reaches the agent', () => {
    const event = buildEvent({
      content: 'two files',
      attachments: [
        {
          id: 'a1',
          filename: 'one.png',
          size: 1,
          url: 'https://cdn.discordapp.com/.../one.png',
          content_type: 'image/png',
        },
        {
          id: 'a2',
          filename: 'two.txt',
          size: 2,
          url: 'https://cdn.discordapp.com/.../two.txt',
          content_type: 'text/plain',
        },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.text).toBe(
      'two files\n[Discord attachment #1: file image/png name=one.png]\n[Discord attachment #2: file text/plain name=two.txt]',
    )
    expect(verdict.payload.attachments).toEqual([
      {
        id: 1,
        kind: 'file',
        ref: 'https://cdn.discordapp.com/.../one.png',
        filename: 'one.png',
        mimetype: 'image/png',
      },
      {
        id: 2,
        kind: 'file',
        ref: 'https://cdn.discordapp.com/.../two.txt',
        filename: 'two.txt',
        mimetype: 'text/plain',
      },
    ])
  })

  test('drops messages before bot identity is known with reason=pre_connect', () => {
    const event = buildEvent({ content: 'no explicit mention' })

    const verdict = classifyInbound(event, baseConfig, null)

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })
})

describe('classifyInbound — thread-created system message', () => {
  test('drops the parent-channel THREAD_CREATED notice (ref points at the new thread, no message_id)', () => {
    const event = buildEvent({
      channel_id: 'parent-c1',
      content: 'my new thread name',
      message_reference: { channel_id: 'thread-t1', guild_id: 'g1' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict).toEqual({ kind: 'drop', reason: 'thread_created_system' })
  })

  test('routes the in-thread THREAD_STARTER_MESSAGE (ref points at parent but carries the original message_id)', () => {
    const event = buildEvent({
      channel_id: 'thread-t1',
      content: 'first message in the thread',
      message_reference: { message_id: 'original-m1', channel_id: 'parent-c1', guild_id: 'g1' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.chat).toBe('thread-t1')
  })

  test('routes a normal same-channel reply (ref.channel_id === event.channel_id)', () => {
    const event = buildEvent({
      channel_id: 'c1',
      content: 'replying here',
      message_reference: { message_id: 'parent-1', channel_id: 'c1' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
  })

  test('routes a cross-channel reference that still carries a message_id (forward/crosspost, not a thread notice)', () => {
    const event = buildEvent({
      channel_id: 'c1',
      content: 'forwarded from elsewhere',
      message_reference: { message_id: 'src-9', channel_id: 'other-c2', guild_id: 'g1' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
  })

  test('does not treat a cross-GUILD reference without message_id as a thread notice', () => {
    const event = buildEvent({
      channel_id: 'c1',
      content: 'unusual cross-guild reference',
      message_reference: { channel_id: 'other-c2', guild_id: 'other-guild' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
  })
})

describe('classifyInbound — peer-bot routing', () => {
  test('routes a peer bot message with authorIsBot=true', () => {
    const event = buildEvent({
      author: { id: 'peer-bot-id', username: 'peer-bot', bot: true },
      content: 'I am another bot speaking',
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(true)
    expect(verdict.payload.authorId).toBe('peer-bot-id')
  })

  test('routes a human message with authorIsBot=false', () => {
    const event = buildEvent({ author: { id: 'u1', username: 'alice', bot: false } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorIsBot).toBe(false)
  })
})

describe('classifyInbound — route path', () => {
  test('routes a guild message that contains a bot mention', () => {
    const event = buildEvent({ content: `hi <@${BOT_USER_ID}>` })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toEqual({
      adapter: 'discord-bot',
      workspace: 'g1',
      chat: 'c1',
      thread: null,
      text: `hi <@${BOT_USER_ID}>`,
      externalMessageId: 'm1',
      reactionRef: encodeDiscordReactionRef({ channel: 'c1', message: 'm1' }),
      authorId: 'u1',
      authorName: 'alice',
      authorIsBot: false,
      isBotMention: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: false,
      ts: Date.parse('2024-01-01T00:00:00Z'),
    })
  })

  test('detects nickname-form mentions <@!id> as bot mentions', () => {
    const event = buildEvent({ content: `hey <@!${BOT_USER_ID}> ping` })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('non-mention guild messages route with isBotMention=false', () => {
    const event = buildEvent({ content: 'good morning team' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('DMs route with workspace=@dm and isDm=true', () => {
    const event = buildEvent({ guild_id: undefined, channel_id: 'dm1', content: 'private hi' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload).toMatchObject({ workspace: '@dm', chat: 'dm1', isDm: true })
  })

  test('reply to bot message surfaces replyToBotMessageId via Discord auto-mention', () => {
    const event = buildEvent({
      content: 'thanks',
      message_reference: { message_id: 'parent-1', channel_id: 'c1' },
      mentions: [{ id: BOT_USER_ID, username: 'me' }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBe('parent-1')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })

  test('drops replies before bot identity is known (cannot classify parent target safely)', () => {
    const event = buildEvent({
      content: 'reply',
      message_reference: { message_id: 'parent-1' },
    })

    const verdict = classifyInbound(event, baseConfig, null)

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })
})

describe('discord-bot classifyInbound — targets-others detection', () => {
  test('marks mentionsOthers=true when only non-bot users are mentioned', () => {
    const event = buildEvent({
      content: 'hey <@u2> can you check?',
      mentions: [{ id: 'u2', username: 'bob' }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(true)
  })

  test('marks mentionsOthers=false when the bot is among the mentioned users', () => {
    const event = buildEvent({
      content: `<@u2> <@${BOT_USER_ID}> please weigh in`,
      mentions: [
        { id: 'u2', username: 'bob' },
        { id: BOT_USER_ID, username: 'me' },
      ],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('marks mentionsOthers=false when the message has no mentions at all', () => {
    const event = buildEvent({ content: 'just some chatter' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.mentionsOthers).toBe(false)
  })

  test('drops mentioned messages during the pre-connected race window (botUserId unknown)', () => {
    const event = buildEvent({
      content: 'hey <@u2>',
      mentions: [{ id: 'u2', username: 'bob' }],
    })

    const verdict = classifyInbound(event, baseConfig, null)

    expect(verdict).toEqual({ kind: 'drop', reason: 'pre_connect' })
  })

  test('reply to a non-bot message surfaces replyToOtherMessageId, not replyToBotMessageId', () => {
    const event = buildEvent({
      content: 'I disagree',
      message_reference: { message_id: 'parent-from-bob' },
      mentions: [{ id: 'u2', username: 'bob' }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBe('parent-from-bob')
  })

  test('reply with no mentions array is still attributed to "other" (parent author unknown but not us)', () => {
    const event = buildEvent({
      content: 'late reply',
      message_reference: { message_id: 'parent-x' },
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToBotMessageId).toBeNull()
    expect(verdict.payload.replyToOtherMessageId).toBe('parent-x')
  })

  test('non-replies leave replyToOtherMessageId null', () => {
    const event = buildEvent({ content: 'just talking' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.replyToOtherMessageId).toBeNull()
  })
})

describe('discord-bot classifyInbound — group mentions', () => {
  test('treats mention_everyone=true (covers @everyone and @here) as a bot mention', () => {
    const event = buildEvent({ content: '@everyone deploy starting', mention_everyone: true })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('treats role mentions (mention_roles non-empty) as a bot mention', () => {
    const event = buildEvent({ content: '<@&role-eng> can someone look', mention_roles: ['role-eng'] })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })

  test('absent mention_everyone/mention_roles fields fall back to direct-mention check', () => {
    const event = buildEvent({ content: 'just chatter' })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('mention_everyone=false with empty mention_roles does not flip isBotMention', () => {
    const event = buildEvent({ content: 'no broadcast', mention_everyone: false, mention_roles: [] })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(false)
  })

  test('group mention combined with @-someone-else still engages the bot', () => {
    const event = buildEvent({
      content: '@here can <@u2> take this?',
      mention_everyone: true,
      mentions: [{ id: 'u2', username: 'bob' }],
    })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.isBotMention).toBe(true)
  })
})

describe('classifyInbound — author name resolution', () => {
  test('prefers global_name (display name) over username so the agent never addresses users by their numeric handle', () => {
    const event = buildEvent({ author: { id: 'u1', username: '1411531', global_name: 'Riley', bot: false } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorName).toBe('Riley')
  })

  test('falls back to username when global_name is absent', () => {
    const event = buildEvent({ author: { id: 'u1', username: 'alice', bot: false } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorName).toBe('alice')
  })

  test('falls back to username when global_name is null (Discord serializes unset display names this way)', () => {
    const event = buildEvent({ author: { id: 'u1', username: 'alice', global_name: null, bot: false } })

    const verdict = classifyInbound(event, baseConfig, BOT_USER_ID)

    expect(verdict.kind).toBe('route')
    if (verdict.kind !== 'route') throw new Error('expected route')
    expect(verdict.payload.authorName).toBe('alice')
  })
})
