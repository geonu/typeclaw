import { expect, test } from 'bun:test'

import { CATCH_UP_CONVERSATION_LIMIT } from '../catch-up'
import { channelsSchema } from '../schema'
import { createSlackMissedInboundCallback } from './slack-bot'

const logger = { info: (_message: string) => {}, warn: (_message: string) => {}, error: (_message: string) => {} }
const config = channelsSchema.parse({ 'slack-bot': {} })['slack-bot']!

test('Slack catch-up lists joined conversations and preserves live Korean mention classification', async () => {
  // Given one joined channel, one unjoined channel, and a later self reply.
  const calls: string[] = []
  const callback = createSlackMissedInboundCallback({
    token: 'test-token',
    logger,
    configRef: () => config,
    identity: () => ({ teamId: 'team', botUserId: 'bot' }),
    targets: async () => [],
    selfAliases: () => [],
    fetchImpl: (async (input, init) => {
      calls.push(String(input))
      if (String(input).endsWith('conversations.list'))
        return Response.json({
          ok: true,
          channels: [
            { id: 'joined', is_member: true },
            { id: 'outside', is_member: false },
          ],
        })
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('channel')).toBe('joined')
      expect(body.get('oldest')).toBe('10')
      return Response.json({
        ok: true,
        messages: [
          { ts: '12.000001', user: 'bot', text: '답변했어요' },
          { ts: '11.000001', user: 'alice', text: '<@bot> 확인 부탁해요' },
        ],
      })
    }) as typeof fetch,
  })
  // When history is listed.
  const items = await callback(10_000)
  // Then only the human message is a candidate, with self activity in moved-on metadata.
  expect(calls).toHaveLength(2)
  expect(items).toHaveLength(1)
  expect(items[0]?.message).toMatchObject({
    text: '<@bot> 확인 부탁해요',
    isBotMention: true,
    thread: '11.000001',
    accountIdentity: 'slack-bot:team:bot',
    revision: 'original',
  })
  expect(items[0]?.latestTs).toBeGreaterThan(items[0]?.message.ts ?? 0)
})

test('Slack catch-up queries watched old threads and resolves the root author', async () => {
  const endpoints: string[] = []
  const callback = createSlackMissedInboundCallback({
    token: 'test-token',
    logger,
    configRef: () => config,
    identity: () => ({ teamId: 'team', botUserId: 'bot' }),
    targets: async () => [{ adapter: 'slack-bot', workspace: 'team', chat: 'joined', thread: '1.000001' }],
    selfAliases: () => [],
    fetchImpl: (async (input, init) => {
      const endpoint = String(input).split('/').at(-1) ?? ''
      endpoints.push(endpoint)
      if (endpoint === 'conversations.list') return Response.json({ ok: true, channels: [] })
      const body = new URLSearchParams(String(init?.body))
      if (endpoint === 'conversations.replies') {
        expect(body.get('ts')).toBe('1.000001')
        return Response.json({
          ok: true,
          messages: [{ ts: '11.000001', user: 'alice', text: '계속 확인해 주세요', thread_ts: '1.000001' }],
        })
      }
      return Response.json({ ok: true, messages: [{ ts: '1.000001', user: 'bot', text: '처음' }] })
    }) as typeof fetch,
  })
  const items = await callback(10_000)
  expect(endpoints).toEqual(['conversations.list', 'conversations.replies', 'conversations.history'])
  expect(items[0]?.message).toMatchObject({ thread: '1.000001', replyToBotMessageId: '1.000001' })
})

test('Slack catch-up bounds history calls even with many joined conversations', async () => {
  let historyCalls = 0
  const callback = createSlackMissedInboundCallback({
    token: 'test-token',
    logger,
    configRef: () => config,
    identity: () => ({ teamId: 'team', botUserId: 'bot' }),
    targets: async () => [],
    selfAliases: () => [],
    fetchImpl: (async (input) => {
      if (String(input).endsWith('conversations.list'))
        return Response.json({
          ok: true,
          channels: Array.from({ length: 100 }, (_, index) => ({ id: `channel-${index}`, is_member: true })),
        })
      historyCalls++
      return Response.json({ ok: true, messages: [] })
    }) as typeof fetch,
  })
  await callback(0)
  expect(historyCalls).toBe(CATCH_UP_CONVERSATION_LIMIT)
})
