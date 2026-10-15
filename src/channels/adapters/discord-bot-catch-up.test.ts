import { expect, test } from 'bun:test'

import { CATCH_UP_CONVERSATION_LIMIT } from '../catch-up'
import { channelsSchema } from '../schema'
import { createDiscordMissedInboundCallback } from './discord-bot'

const logger = { info: (_message: string) => {}, warn: (_message: string) => {}, error: (_message: string) => {} }
const config = channelsSchema.parse({ 'discord-bot': {} })['discord-bot']!

test('Discord catch-up reads watched thread history with live classification and later self activity', async () => {
  const calls: string[] = []
  const callback = createDiscordMissedInboundCallback({
    token: 'test-token',
    logger,
    configRef: () => config,
    botUserIdRef: () => 'bot',
    targets: async () => [{ adapter: 'discord-bot', workspace: 'guild', chat: 'thread', thread: null }],
    room: async () => ({ kind: 'thread', parentChat: 'parent' }),
    fetchImpl: (async (input) => {
      calls.push(String(input))
      return Response.json([
        {
          id: 'later',
          channel_id: 'thread',
          author: { id: 'bot', username: 'Bot', bot: true },
          content: '답변했어요',
          timestamp: '2026-10-15T12:00:02Z',
        },
        {
          id: 'missed',
          channel_id: 'thread',
          author: { id: 'alice', username: 'Alice' },
          content: '<@bot> 확인 부탁해요',
          timestamp: '2026-10-15T12:00:01Z',
          mentions: [{ id: 'bot', username: 'Bot' }],
        },
      ])
    }) as typeof fetch,
  })
  const items = await callback(Date.parse('2026-10-15T12:00:00Z'))
  expect(calls).toEqual(['https://discord.com/api/v10/channels/thread/messages?limit=100'])
  expect(items).toHaveLength(1)
  expect(items[0]?.message).toMatchObject({
    text: '<@bot> 확인 부탁해요',
    isBotMention: true,
    chat: 'thread',
    thread: null,
    room: { kind: 'thread', parentChat: 'parent' },
    accountIdentity: 'discord-bot:bot',
    revision: 'original',
  })
  expect(items[0]?.latestTs).toBeGreaterThan(items[0]?.message.ts ?? 0)
})

test('Discord catch-up bounds calls and does not enumerate unwatched channels', async () => {
  let calls = 0
  const callback = createDiscordMissedInboundCallback({
    token: 'test-token',
    logger,
    configRef: () => config,
    botUserIdRef: () => 'bot',
    targets: async () =>
      Array.from({ length: 100 }, (_, index) => ({
        adapter: 'discord-bot',
        workspace: '@dm',
        chat: `dm-${index}`,
        thread: null,
      })),
    room: async () => undefined,
    fetchImpl: Object.assign(
      async () => {
        calls++
        return Response.json([])
      },
      { preconnect: fetch.preconnect },
    ),
  })
  expect(await callback(0)).toEqual([])
  expect(calls).toBe(CATCH_UP_CONVERSATION_LIMIT)
})
