import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import FakeTimers from '@sinonjs/fake-timers'
import type { SlackBotClient, SlackFile, SlackSocketModeSlashCommandArgs } from 'agent-messenger/slackbot'

import { buildChannelTools } from '@/agent'
import type { SessionOrigin } from '@/agent/session-origin'
import { createChannelReplyTool } from '@/agent/tools/channel-reply'
import { noopPermissionService } from '@/permissions'
import { createHookBus, type HookBus, type ChannelOutboundBeforeEvent } from '@/plugin'

import { createOutboundCallback, createSlashCommandHandler, SLACK_SLASH_COMMAND_NAMES } from './adapters/slack-bot'
import { commandResultReply, type SlashAckPayload } from './adapters/slack-bot-slash-commands'
import { createChannelRouter, type ChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'
import type { OutboundMessage } from './types'

const logger = { info() {}, warn() {}, error() {} }
const target = { adapter: 'slack-bot' as const, workspace: 'T_EXAMPLE', chat: 'C_EXAMPLE' }
const roots: string[] = []
const routers: ChannelRouter[] = []
const toolContext = {} as ExtensionToolContext

afterEach(async () => {
  for (const router of routers.splice(0)) await router.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function setup(bus: HookBus) {
  const root = await mkdtemp(join(tmpdir(), 'typeclaw-channel-hooks-'))
  roots.push(root)
  const router = createChannelRouter({
    agentDir: root,
    logger,
    configForAdapter: () => ({
      enabled: true,
      engagement: { trigger: ['mention'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }),
    permissions: { ...noopPermissionService, has: () => true },
    createSessionForChannel: async () => {
      throw new Error('Explicit sends must not create a model session')
    },
    reviewOutbound: (event) => bus.runChannelOutboundBefore(event),
    outboundReviewerActive: () => bus.count('channel.outbound.before') > 0,
  })
  routers.push(router)
  return { root, router }
}

test('actual channel tools echo reviewed send, reply and edit text without changing destinations or message ids', async () => {
  const bus = createHookBus()
  const events: ChannelOutboundBeforeEvent[] = []
  bus.registerAll('copy-editor', '/agent', logger, {
    'channel.outbound.before': (event) => {
      events.push(event)
      return { text: `검토한 ${event.op} 문장입니다.` }
    },
  })
  const { router } = await setup(bus)
  const delivered: Array<{ chat: string; text: string }> = []
  router.registerOutbound(
    'slack-bot',
    createOutboundCallback({
      client: {
        postMessage: async (chat: string, text: string) => {
          delivered.push({ chat, text })
          return { ts: '123.000001' }
        },
      } as unknown as SlackBotClient,
      logger,
      formatChannelTag: async () => 'synthetic',
    }),
  )
  router.registerEditMessage('slack-bot', async (request) => {
    expect(request.messageId).toBe('123.000001')
    delivered.push({ chat: request.chat, text: request.text })
    return { ok: true }
  })
  let currentOrigin: SessionOrigin | undefined = { kind: 'cron', jobId: 'old-digest', jobKind: 'prompt' }
  const tools = buildChannelTools(router, currentOrigin, undefined, () => currentOrigin)
  currentOrigin = { kind: 'cron', jobId: 'example-digest', jobKind: 'prompt' }
  const send = tools.find((tool) => tool.name === 'channel_send')!
  const sent = await send.execute('send', { ...target, text: '초안입니다.' }, undefined, undefined, toolContext)
  expect(JSON.stringify(sent.content)).toContain('검토한 send 문장입니다.')
  expect(JSON.stringify(sent.content)).toContain('123.000001')
  const reply = createChannelReplyTool({ router, origin: { ...target, thread: null }, logger })
  const replied = await reply.execute('reply', { text: '답변 초안입니다.' }, undefined, undefined, toolContext)
  expect(JSON.stringify(replied.content)).toContain('검토한 send 문장입니다.')
  currentOrigin = undefined
  const edit = tools.find((tool) => tool.name === 'channel_edit')!
  const edited = await edit.execute(
    'edit',
    { ...target, message_id: '123.000001', text: '수정 초안입니다.' },
    undefined,
    undefined,
    toolContext,
  )
  expect(JSON.stringify(edited.content)).toContain('검토한 edit 문장입니다.')
  expect(delivered).toEqual([
    { chat: target.chat, text: '검토한 send 문장입니다.' },
    { chat: target.chat, text: '검토한 send 문장입니다.' },
    { chat: target.chat, text: '검토한 edit 문장입니다.' },
  ])
  expect(events.map((event) => ({ op: event.op, source: event.source, origin: event.origin }))).toEqual([
    { op: 'send', source: 'tool', origin: { kind: 'cron', jobId: 'example-digest' } },
    { op: 'send', source: 'tool', origin: undefined },
    { op: 'edit', source: 'tool', origin: undefined },
  ])
})

test('attachment captions are transformed once, while attachment-only uploads cannot gain a text post or caption', async () => {
  const bus = createHookBus()
  let reviews = 0
  bus.registerAll('copy-editor', '/agent', logger, {
    'channel.outbound.before': () => {
      reviews++
      return { text: 'Reviewed caption' }
    },
  })
  const { root, router } = await setup(bus)
  const path = join(root, 'example.txt')
  await writeFile(path, 'synthetic attachment')
  const captions: Array<string | undefined> = []
  router.registerOutbound(
    'slack-bot',
    createOutboundCallback({
      client: {
        postMessage: async () => {
          throw new Error('Must not post a second text message')
        },
        uploadFile: async (_chat, _bytes, _filename, options) => {
          captions.push(options?.initial_comment)
          return { id: 'F_EXAMPLE' } as SlackFile
        },
      } as Pick<SlackBotClient, 'postMessage' | 'uploadFile'>,
      logger,
      formatChannelTag: async () => 'synthetic',
    }),
  )
  const attachments = [{ path, filename: 'example.txt' }]
  expect(await router.send({ ...target, text: 'Draft caption', attachments })).toMatchObject({ ok: true })
  expect(await router.send({ ...target, attachments })).toMatchObject({ ok: true })
  expect(captions).toEqual(['Reviewed caption', undefined])
  expect(reviews).toBe(2)
})

test('existing system and recovery sends are reviewed without changing their transport identity or options', async () => {
  const bus = createHookBus()
  const events: ChannelOutboundBeforeEvent[] = []
  bus.registerAll('copy-editor', '/agent', logger, {
    'channel.outbound.before': (event) => {
      events.push(event)
      return { text: 'Reviewed runtime notice' }
    },
  })
  const { router } = await setup(bus)
  const delivered: OutboundMessage[] = []
  router.registerOutbound('slack-bot', async (message) => {
    delivered.push(message)
    return { ok: true, messageId: '123.000002' }
  })
  expect(
    await router.send({ ...target, text: 'Provider notice' }, { source: 'system', outputKind: 'meta' }),
  ).toMatchObject({ ok: true, deliveredText: 'Reviewed runtime notice' })
  const recovery = {
    source: 'system' as const,
    accounting: 'recovery' as const,
    deliveryId: 'example-delivery',
    expectedAccountIdentity: 'example-account',
    coveredIds: ['example-inbound'],
  }
  expect(await router.send({ ...target, text: 'Recovery notice' }, recovery)).toMatchObject({
    ok: true,
    messageId: '123.000002',
    deliveredText: 'Reviewed runtime notice',
  })
  expect(delivered.map((message) => message.text)).toEqual(['Reviewed runtime notice', 'Reviewed runtime notice'])
  expect(delivered[1]!.sendOptions).toEqual(recovery)
  expect(events.map((event) => [event.source, event.outputKind])).toEqual([
    ['system', 'meta'],
    ['system', 'meta'],
  ])
})

test('a replacement cannot reintroduce reasoning blocks, blank delivery or flood text', async () => {
  const bus = createHookBus()
  const { router } = await setup(bus)
  const delivered: string[] = []
  router.registerOutbound('slack-bot', async (message) => {
    delivered.push(message.text!)
    return { ok: true }
  })
  for (const replacement of ['<think>synthetic internal reasoning</think>', 'x'.repeat(500), '  ']) {
    bus.registerAll('bad-editor', '/agent', logger, {
      'channel.outbound.before': () => ({ text: replacement }),
    })
    expect(await router.send({ ...target, text: 'Original visible text' })).toMatchObject({ ok: true })
    bus.unregisterAll('bad-editor')
  }
  expect(delivered).toEqual(['Original visible text', 'Original visible text', 'Original visible text'])
})

function slashArgs(ack: SlackSocketModeSlashCommandArgs['ack'], responseUrl?: string): SlackSocketModeSlashCommandArgs {
  return {
    ack,
    envelope_id: 'example-envelope',
    body: {
      command: '/stop',
      text: '',
      user_id: 'U_EXAMPLE',
      channel_id: target.chat,
      team_id: target.workspace,
      ...(responseUrl ? { response_url: responseUrl } : {}),
    },
  } as SlackSocketModeSlashCommandArgs
}

test('slash commands ack before slow execution/review and deliver exactly one reviewed ephemeral response', async () => {
  const bus = createHookBus()
  const reviewStarted = Promise.withResolvers<void>()
  const releaseReview = Promise.withResolvers<{ text: string }>()
  bus.registerAll('copy-editor', '/agent', logger, {
    'channel.outbound.before': () => {
      reviewStarted.resolve()
      return releaseReview.promise
    },
  })
  const { router } = await setup(bus)
  let acknowledgements = 0
  const posted: SlashAckPayload[] = []
  const execute = Promise.withResolvers<void>()
  const handler = createSlashCommandHandler({
    router: {
      ...router,
      executeCommand: async () => {
        await execute.promise
        return { kind: 'permission-denied' }
      },
    },
    knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
    logger,
    formatChannelTag: async () => 'synthetic',
    postSlashResponse: async (url, payload) => {
      expect(url).toBe('https://hooks.slack.com/commands/T_EXAMPLE/example-token')
      posted.push(payload)
      return 200
    },
  })
  const handling = handler(
    slashArgs((payload) => {
      acknowledgements++
      expect(payload).toBeUndefined()
    }, 'https://hooks.slack.com/commands/T_EXAMPLE/example-token'),
  )
  expect(acknowledgements).toBe(1)
  execute.resolve()
  await reviewStarted.promise
  expect(posted).toEqual([])
  releaseReview.resolve({ text: 'Reviewed permission-denied response' })
  await handling
  expect(acknowledgements).toBe(1)
  expect(posted).toEqual([{ response_type: 'ephemeral', text: 'Reviewed permission-denied response' }])
})

test('unsafe or absent slash response URLs fail open to the original ack without network access', async () => {
  const bus = createHookBus()
  bus.registerAll('copy-editor', '/agent', logger, { 'channel.outbound.before': () => ({ text: 'reviewed' }) })
  const { router } = await setup(bus)
  const acks: unknown[] = []
  let posts = 0
  const handler = createSlashCommandHandler({
    router: { ...router, executeCommand: async () => ({ kind: 'permission-denied' }) },
    knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
    logger,
    formatChannelTag: async () => 'synthetic',
    postSlashResponse: async () => {
      posts++
      return 200
    },
  })
  for (const url of [
    undefined,
    'http://hooks.slack.com/commands/example',
    'https://hooks.slack.com.evil.example/commands/example',
    'https://user@hooks.slack.com/commands/example',
    'https://hooks.slack.com:8443/commands/example',
    'https://hooks.slack.com/services/example',
    'https://127.0.0.1/commands/example',
  ])
    await handler(
      slashArgs((payload) => {
        acks.push(payload)
      }, url),
    )
  expect(posts).toBe(0)
  expect(acks).toEqual(
    Array.from({ length: 7 }, () => ({
      response_type: 'ephemeral',
      text: commandResultReply({ kind: 'permission-denied' }),
    })),
  )
})

test('a slow control reviewer cannot hold the restart response beyond its total budget or post a late replacement', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] })
  const late = Promise.withResolvers<{ text: string }>()
  try {
    const bus = createHookBus()
    bus.registerAll('slow-editor', '/agent', logger, { 'channel.outbound.before': () => late.promise })
    const { router } = await setup(bus)
    let acknowledgements = 0
    const posted: SlashAckPayload[] = []
    const handler = createSlashCommandHandler({
      router: { ...router, executeCommand: async () => ({ kind: 'permission-denied' }) },
      knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
      logger,
      formatChannelTag: async () => 'synthetic',
      postSlashResponse: async (_url, payload) => {
        posted.push(payload)
        return 200
      },
    })
    const handling = handler(
      slashArgs(() => {
        acknowledgements++
      }, 'https://hooks.slack.com/commands/T_EXAMPLE/example-token'),
    )
    await clock.tickAsync(1_000)
    await handling
    late.resolve({ text: 'Late replacement must not be delivered' })
    await clock.tickAsync(0)
    expect(acknowledgements).toBe(1)
    expect(posted).toEqual([
      {
        response_type: 'ephemeral',
        text: commandResultReply({ kind: 'permission-denied' }),
      },
    ])
  } finally {
    late.resolve({ text: 'Late replacement must not be delivered' })
    clock.uninstall()
  }
})

test('slash response transport errors neither expose the credential URL nor cause a second ack/post', async () => {
  const bus = createHookBus()
  bus.registerAll('copy-editor', '/agent', logger, { 'channel.outbound.before': () => ({ text: 'Reviewed response' }) })
  const { router } = await setup(bus)
  const warnings: string[] = []
  let acknowledgements = 0
  let posts = 0
  const handler = createSlashCommandHandler({
    router: { ...router, executeCommand: async () => ({ kind: 'permission-denied' }) },
    knownCommandNames: SLACK_SLASH_COMMAND_NAMES,
    logger: { ...logger, warn: (line) => warnings.push(line) },
    formatChannelTag: async () => 'synthetic',
    postSlashResponse: async () => {
      posts++
      throw new Error('https://hooks.slack.com/commands/T_EXAMPLE/SYNTHETIC_SECRET Reviewed response')
    },
  })
  await handler(
    slashArgs(() => {
      acknowledgements++
    }, 'https://hooks.slack.com/commands/T_EXAMPLE/SYNTHETIC_SECRET'),
  )
  expect(acknowledgements).toBe(1)
  expect(posts).toBe(1)
  expect(warnings).toEqual(['[slack-bot] slash response transport failed'])
})
