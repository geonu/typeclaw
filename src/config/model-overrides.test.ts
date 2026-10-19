import { describe, expect, test } from 'bun:test'

import type { SessionOrigin } from '@/agent/session-origin'

import { configSchema, resolveProfile } from './config'
import { effectiveModels } from './model-overrides'

const GLOBAL = 'openai/gpt-5.4'
const GLOBAL_FAST = 'openai/gpt-5.4-nano'
const SLACK = 'openai/gpt-5.4-mini'
const VIP = 'anthropic/claude-opus-4-5'

function config(modelOverrides: Record<string, unknown>) {
  return configSchema.parse({ models: { default: GLOBAL, fast: GLOBAL_FAST }, modelOverrides })
}

function channel(adapter: string, workspace: string, chat: string): SessionOrigin {
  return { kind: 'channel', adapter, workspace, chat, thread: null, participants: [] } as unknown as SessionOrigin
}

function refOf(cfg: ReturnType<typeof config>, origin: SessionOrigin | undefined, profile?: string): string {
  return resolveProfile(effectiveModels(cfg, origin), profile).ref as string
}

describe('effectiveModels', () => {
  // Declared broad-last so a pass relies on specificity, not declaration order.
  const cfg = config({
    vip: { match: ['slack:T0123/C0VIP', 'discord:G1/C2'], models: { default: VIP } },
    slack: { match: ['slack:*'], models: { default: SLACK, fast: SLACK } },
  })

  test('the most specific matching rule wins per profile', () => {
    expect(refOf(cfg, channel('slack', 'T0123', 'C0VIP'))).toBe(VIP)
    expect(refOf(cfg, channel('slack', 'T0123', 'C0OTHER'))).toBe(SLACK)
  })

  test('profiles the winning entry does not define fall through to the next match, then global', () => {
    expect(refOf(cfg, channel('slack', 'T0123', 'C0VIP'), 'fast')).toBe(SLACK)
    expect(refOf(cfg, channel('discord-bot', 'G1', 'C2'), 'fast')).toBe(GLOBAL_FAST)
  })

  test('one entry covers several rules and every adapter of a platform', () => {
    expect(refOf(cfg, channel('discord-bot', 'G1', 'C2'))).toBe(VIP)
    expect(refOf(cfg, channel('slack-bot', 'T9', 'C9'))).toBe(SLACK)
  })

  test('the later-declared entry wins a specificity tie', () => {
    const tied = config({
      first: { match: ['slack:*'], models: { default: SLACK } },
      second: { match: ['slack:*'], models: { default: VIP } },
    })
    expect(refOf(tied, channel('slack', 'T0123', 'C1'))).toBe(VIP)
  })

  test('subagents resolve against the channel that spawned them; tui stays global', () => {
    const subagent = {
      kind: 'subagent',
      subagent: 'worker',
      parentSessionId: 'p',
      spawnedByOrigin: {
        kind: 'subagent',
        subagent: 'x',
        parentSessionId: 'q',
        spawnedByOrigin: channel('slack', 'T0123', 'C1'),
      },
    } as SessionOrigin
    expect(refOf(cfg, subagent, 'fast')).toBe(SLACK)
    expect(refOf(cfg, { kind: 'tui' } as SessionOrigin)).toBe(GLOBAL)
  })
})

describe('modelOverrides schema', () => {
  const parses = (modelOverrides: Record<string, unknown>) =>
    configSchema.safeParse({ models: { default: GLOBAL }, modelOverrides }).success

  test('accepts channel rules and rejects empty match, non-channel or author rules, and empty models', () => {
    expect(parses({ a: { match: ['*', 'slack:dm/*'], models: { default: SLACK } } })).toBe(true)
    expect(parses({ a: { match: [], models: { default: SLACK } } })).toBe(false)
    expect(parses({ a: { match: ['cron'], models: { default: SLACK } } })).toBe(false)
    expect(parses({ a: { match: ['slack:T0123 author:U1'], models: { default: SLACK } } })).toBe(false)
    expect(parses({ a: { match: ['slack:*'], models: {} } })).toBe(false)
  })

  test('materializes built-in per-profile thinking defaults inside overrides', () => {
    const cfg = config({ a: { match: ['slack:*'], models: { fast: SLACK } } })
    expect(cfg.modelOverrides.a?.models.fast?.thinkingLevel).toBe('low')
  })
})
