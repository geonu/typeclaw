import { describe, expect, test } from 'bun:test'

import type { Model } from '@earendil-works/pi-ai'

import {
  COMPACTION_ABSOLUTE_TRIGGER_TOKENS,
  COMPACTION_KEEP_RECENT_TOKENS,
  COMPACTION_TRIGGER_PERCENT,
  compactionTriggerTokens,
  createCompactionSettingsManager,
  reserveTokensForModel,
} from './compaction'

function fakeModel(contextWindow: number): Model<'openai-completions'> {
  return {
    id: 'fake',
    name: 'Fake',
    api: 'openai-completions',
    provider: 'fake',
    baseUrl: 'https://example',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: contextWindow,
  } as unknown as Model<'openai-completions'>
}

describe('compactionTriggerTokens', () => {
  test('small windows keep the 80% window-relative trigger', () => {
    // given: a window whose 80% sits below the absolute cap
    const window = 64_000
    const model = fakeModel(window)

    // when
    const trigger = compactionTriggerTokens(model)

    // then
    expect(trigger).toBe(Math.round(window * COMPACTION_TRIGGER_PERCENT))
    expect(trigger).toBe(51_200)
  })

  test('large windows cap the trigger at the absolute budget instead of 80%', () => {
    // given: 80% of 256K (204_800) is well above the absolute cap
    const model = fakeModel(256_000)

    // when
    const trigger = compactionTriggerTokens(model)

    // then
    expect(trigger).toBe(COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
  })

  test('very large windows still cap at the same absolute trigger', () => {
    // given
    const a = fakeModel(256_000)
    const b = fakeModel(1_000_000)

    // then: trigger does not scale with the window once past the crossover
    expect(compactionTriggerTokens(a)).toBe(COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
    expect(compactionTriggerTokens(b)).toBe(COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
  })
})

describe('reserveTokensForModel', () => {
  test('derives reserve as window minus the (capped) trigger', () => {
    // given
    const model = fakeModel(256_000)

    // when
    const reserve = reserveTokensForModel(model)

    // then: 256K - 64K cap = 192K reserved, so compaction fires at 64K not 80%
    expect(reserve).toBe(256_000 - COMPACTION_ABSOLUTE_TRIGGER_TOKENS)
    expect(reserve).toBe(192_000)
  })

  test('clamps to at least 1 so a degenerate zero-window model never produces a non-positive reserve', () => {
    // given
    const broken = fakeModel(0)

    // when
    const reserve = reserveTokensForModel(broken)

    // then
    expect(reserve).toBeGreaterThanOrEqual(1)
  })
})

describe('compaction budget invariant', () => {
  test('absolute trigger stays >=3x the recent-window floor to avoid thrashing', () => {
    // a trigger too close to keepRecent would re-compact almost immediately
    // after each compaction; keep headroom so a compacted session can grow
    expect(COMPACTION_ABSOLUTE_TRIGGER_TOKENS).toBeGreaterThanOrEqual(COMPACTION_KEEP_RECENT_TOKENS * 3)
  })
})

describe('createCompactionSettingsManager', () => {
  test('produces a SettingsManager whose getCompactionSettings() reflects our chosen values', () => {
    // given
    const model = fakeModel(256_000)

    // when
    const settings = createCompactionSettingsManager(model).getCompactionSettings()

    // then
    expect(settings.enabled).toBe(true)
    expect(settings.reserveTokens).toBe(reserveTokensForModel(model))
    expect(settings.keepRecentTokens).toBe(COMPACTION_KEEP_RECENT_TOKENS)
  })

  test('different-window models reserve different amounts but keep the same recent window', () => {
    // given
    const a = fakeModel(200_000)
    const b = fakeModel(1_000_000)

    // when
    const sa = createCompactionSettingsManager(a).getCompactionSettings()
    const sb = createCompactionSettingsManager(b).getCompactionSettings()

    // then
    expect(sa.reserveTokens).not.toBe(sb.reserveTokens)
    expect(sa.keepRecentTokens).toBe(sb.keepRecentTokens)
  })
})
