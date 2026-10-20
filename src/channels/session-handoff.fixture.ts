import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AssistantMessage } from '@earendil-works/pi-ai'
import { SessionManager, type ExtensionToolContext } from '@earendil-works/pi-coding-agent'

import { createSessionWithDispose } from '@/agent'
import type { SessionOrigin } from '@/agent/session-origin'
import { createPermissionService, rolesConfigSchema, type RolesConfig } from '@/permissions'

import { createChannelRouter, type CreateChannelRouterOptions } from './router'
import { defaultHistoryConfig } from './schema'
import { channelKeyId, type ChannelKey, type InboundMessage, type OutboundMessage } from './types'

export const sourceKey: ChannelKey = { adapter: 'discord', workspace: 'guild', chat: 'source', thread: null }
export const targetKey: ChannelKey = { adapter: 'discord-bot', workspace: 'guild', chat: 'target', thread: null }

export function inbound(key: ChannelKey, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    ...key,
    accountIdentity: `${key.adapter}-account`,
    externalMessageId: crypto.randomUUID(),
    text: 'Please help.',
    authorId: 'alice',
    authorName: 'Alice',
    authorIsBot: false,
    isBotMention: true,
    isDm: false,
    mentionsOthers: false,
    replyToBotMessageId: null,
    replyToOtherMessageId: null,
    ts: 1000,
    ...overrides,
  }
}

type SessionState = {
  readonly id: string
  readonly origin: { current: SessionOrigin | undefined }
  readonly prompts: string[]
  readonly context: ExtensionToolContext
  onPrompt?: () => Promise<void>
}

export async function handoffFixture(
  options: {
    roles?: RolesConfig
    claimHandler?: CreateChannelRouterOptions['claimHandler']
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'typeclaw-session-handoff-'))
  const permissions = createPermissionService({
    roles: options.roles ?? rolesConfigSchema.parse({ member: { match: ['discord:*'] } }),
  })
  const sessions = new Map<string, SessionState>()
  const sent: OutboundMessage[] = []
  const logs: string[] = []
  const clock = { now: 1000 }
  const router = createChannelRouter({
    agentDir: dir,
    permissions,
    now: () => clock.now,
    claimHandler: options.claimHandler,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    configForAdapter: () => ({
      enabled: true,
      engagement: { trigger: ['mention', 'reply', 'dm'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }),
    createSessionForChannel: async ({ key, origin, originRef }) => {
      const result = await createSessionWithDispose({
        sessionManager: SessionManager.create(dir, join(dir, 'sessions')),
        systemPromptOverride: 'Use channel tools.',
        tools: [],
        customTools: [],
        origin,
        originRef,
      })
      const state: SessionState = {
        id: result.session.sessionId,
        origin: originRef,
        prompts: [],
        context: result.session.extensionRunner.createToolContext('handoff-test', undefined),
      }
      sessions.set(channelKeyId(key), state)
      result.session.prompt = async (text) => {
        if (typeof text === 'string') state.prompts.push(text)
        await state.onPrompt?.()
        const response: AssistantMessage = {
          role: 'assistant',
          content: [{ type: 'text', text: 'NO_REPLY' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'test-model',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: clock.now,
        }
        result.session.sessionManager.appendMessage(response)
      }
      return { session: result.session, sessionId: state.id, dispose: result.dispose }
    },
  })
  for (const adapter of ['discord', 'discord-bot', 'slack-bot'] as const) {
    router.registerOutbound(adapter, async (message) => {
      sent.push(message)
      return { ok: true, messageId: 'posted-message' }
    })
  }
  const testing = router.__testing
  if (testing === undefined) throw new Error('router test controls are unavailable')
  const session = (key: ChannelKey): SessionState => {
    const state = sessions.get(channelKeyId(key))
    if (state === undefined) throw new Error(`missing test session ${channelKeyId(key)}`)
    return state
  }
  return {
    router,
    permissions,
    sessions,
    session,
    sent,
    logs,
    clock,
    flush: testing.flushDebounce,
    async receive(event: InboundMessage) {
      await router.route(event)
      await testing.flushDebounce(event)
    },
    async [Symbol.asyncDispose]() {
      await router.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}
