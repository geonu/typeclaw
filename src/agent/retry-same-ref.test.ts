import { describe, expect, test } from 'bun:test'

import type { AgentSession } from './index'
import {
  promptWithSameRefRetryOnly,
  RESPONSIVE_OVERLOAD_RETRIES,
  retryBackoffMs,
  retryTurnAfterCompletedToolResult,
  retryTurnOnPersistentSession,
} from './retry-same-ref'

describe('retryBackoffMs', () => {
  test('is full-jitter: random in [0, min(cap, base·2^attempt))', () => {
    // given random()=1 (upper bound), attempt 0 -> ceiling = base(1000)
    expect(retryBackoffMs(0, () => 0.999999)).toBe(999)
    // attempt 1 -> ceiling = min(5000, 2000) = 2000
    expect(retryBackoffMs(1, () => 0.5)).toBe(1000)
    // attempt grows past the cap -> clamped to MAX_DELAY_MS (5000)
    expect(retryBackoffMs(10, () => 0.999999)).toBe(4999)
  })

  test('random()=0 yields no delay (immediate retry allowed)', () => {
    expect(retryBackoffMs(3, () => 0)).toBe(0)
  })
})

type FakeAgent = {
  state: { messages: Array<{ role: string; stopReason?: string }> }
  continue: () => Promise<void>
  continued: number
}

function sessionWith(
  messages: Array<{ role: string; stopReason?: string }>,
  continueImpl?: (agent: FakeAgent) => Promise<void>,
) {
  const agent: FakeAgent = {
    state: { messages },
    continued: 0,
    continue: async () => {
      agent.continued++
      await continueImpl?.(agent)
    },
  }
  return { session: { agent } as unknown as AgentSession, agent }
}

describe('retryTurnOnPersistentSession', () => {
  test('pops the trailing assistant error leaf, then continues (no user-message re-append)', async () => {
    const messages = [{ role: 'user' }, { role: 'assistant', stopReason: 'error' }]
    const { session, agent } = sessionWith(messages)

    const ok = await retryTurnOnPersistentSession(session, { attempt: 0, random: () => 0 })

    expect(ok).toBe(true)
    expect(agent.continued).toBe(1)
    // the failed assistant leaf is gone; the user message is untouched (not duplicated)
    expect(agent.state.messages).toEqual([{ role: 'user' }])
  })

  test('retries a trailing USER leaf WITHOUT popping — the pre-stream incident shape', async () => {
    // given: the provider died before writing any assistant message, so the turn
    // is still just the user message (no assistant error leaf to pop)
    const messages = [{ role: 'user' }]
    const { session, agent } = sessionWith(messages)

    const ok = await retryTurnOnPersistentSession(session, { attempt: 0, random: () => 0 })

    expect(ok).toBe(true)
    expect(agent.continued).toBe(1)
    expect(agent.state.messages).toEqual([{ role: 'user' }]) // untouched, not re-appended
  })

  test('fails closed when the trailing message is neither user nor assistant', async () => {
    const { session, agent } = sessionWith([{ role: 'user' }, { role: 'toolResult' }])

    const ok = await retryTurnOnPersistentSession(session, { attempt: 0, random: () => 0 })

    expect(ok).toBe(false)
    expect(agent.continued).toBe(0)
  })

  test('fails closed when the session exposes no agent.continue', async () => {
    const session = {
      agent: { state: { messages: [{ role: 'assistant', stopReason: 'error' }] } },
    } as unknown as AgentSession
    expect(await retryTurnOnPersistentSession(session, { attempt: 0, random: () => 0 })).toBe(false)
  })

  test('fails closed on an empty transcript', async () => {
    const { session } = sessionWith([])
    expect(await retryTurnOnPersistentSession(session, { attempt: 0, random: () => 0 })).toBe(false)
  })

  test('propagates a throw from continue() so the caller can surface it', async () => {
    const { session } = sessionWith([{ role: 'user' }, { role: 'assistant', stopReason: 'error' }], async () => {
      throw new Error('socket hang up')
    })
    await expect(retryTurnOnPersistentSession(session, { attempt: 0, random: () => 0 })).rejects.toThrow(
      'socket hang up',
    )
  })
})

describe('retryTurnAfterCompletedToolResult', () => {
  test('removes only an error assistant after a completed tool result, then continues', async () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant', stopReason: 'toolUse' },
      { role: 'toolResult' },
      { role: 'assistant', stopReason: 'error' },
    ]
    const { session, agent } = sessionWith(messages)

    const ok = await retryTurnAfterCompletedToolResult(session, {
      attempt: 0,
      random: () => 0,
      authorize: () => true,
    })

    expect(ok).toBe(true)
    expect(agent.continued).toBe(1)
    expect(agent.state.messages).toEqual(messages.slice(0, -1))
  })

  test('signals backoff after tail eligibility and before jitter/authorization', async () => {
    const order: string[] = []
    const { session } = sessionWith([{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }], async () => {
      order.push('continue')
    })

    expect(
      await retryTurnAfterCompletedToolResult(session, {
        attempt: 0,
        onBackoffStart: () => order.push('backoff-start'),
        random: () => {
          order.push('random')
          return 0
        },
        authorize: () => {
          order.push('authorize')
          return true
        },
      }),
    ).toBe(true)
    expect(order).toEqual(['backoff-start', 'random', 'authorize', 'continue'])
  })

  test('honors an explicit delay instead of the ordinary jitter curve', async () => {
    const order: string[] = []
    const { session } = sessionWith([{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }], async () => {
      order.push('continue')
    })

    expect(
      await retryTurnAfterCompletedToolResult(session, {
        attempt: 0,
        delayMs: 0,
        random: () => {
          order.push('random')
          return 0
        },
        authorize: () => true,
      }),
    ).toBe(true)
    expect(order).toEqual(['continue'])
  })

  test('fails closed without mutation for unsafe transcript tails', async () => {
    const unsafeTails = [
      [{ role: 'toolResult' }],
      [{ role: 'user' }, { role: 'assistant', stopReason: 'error' }],
      [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'stop' }],
      [{ role: 'user' }, { role: 'toolResult' }],
    ]

    for (const messages of unsafeTails) {
      const original = messages.map((message) => ({ ...message }))
      const { session, agent } = sessionWith(messages)
      expect(
        await retryTurnAfterCompletedToolResult(session, {
          attempt: 0,
          random: () => 0,
          authorize: () => true,
        }),
      ).toBe(false)
      expect(agent.continued).toBe(0)
      expect(agent.state.messages).toEqual(original)
    }
  })

  test('reauthorizes after backoff and fails closed when authorization was revoked', async () => {
    const messages = [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }]
    const { session, agent } = sessionWith(messages)
    let authorized = true

    const retry = retryTurnAfterCompletedToolResult(session, {
      attempt: 0,
      random: () => 0.001,
      authorize: () => authorized,
    })
    authorized = false

    expect(await retry).toBe(false)
    expect(agent.continued).toBe(0)
    expect(agent.state.messages).toBe(messages)
  })

  test('restores the removed error leaf when continue throws without transcript progress', async () => {
    const messages = [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }]
    const { session, agent } = sessionWith(messages, async () => {
      throw new Error('socket hang up')
    })

    await expect(
      retryTurnAfterCompletedToolResult(session, {
        attempt: 0,
        random: () => 0,
        authorize: () => true,
      }),
    ).rejects.toThrow('socket hang up')

    expect(agent.continued).toBe(1)
    expect(agent.state.messages).toBe(messages)
  })

  test('preserves newer transcript progress when continue appends state before throwing', async () => {
    const messages = [{ role: 'toolResult' }, { role: 'assistant', stopReason: 'error' }]
    const progress = { role: 'assistant', stopReason: 'error' }
    const { session, agent } = sessionWith(messages, async (currentAgent) => {
      currentAgent.state.messages = [...currentAgent.state.messages, progress]
      throw new Error('socket hang up after progress')
    })

    await expect(
      retryTurnAfterCompletedToolResult(session, {
        attempt: 0,
        random: () => 0,
        authorize: () => true,
      }),
    ).rejects.toThrow('socket hang up after progress')

    expect(agent.continued).toBe(1)
    expect(agent.state.messages).toEqual([{ role: 'toolResult' }, progress])
    expect(agent.state.messages).not.toBe(messages)
  })
})

type PromptScript = Array<'soft-transient' | 'soft-overload' | 'hard-transient' | 'hard-auth' | 'success'>

function promptFake(script: PromptScript) {
  const listeners = new Set<(event: { type: string; message?: unknown }) => void>()
  const messages: Array<{ role: string; stopReason?: string }> = []
  let idx = 0
  const step = (viaContinue: boolean) => {
    const behavior = script[Math.min(idx, script.length - 1)]!
    idx++
    if (!viaContinue) messages.push({ role: 'user' })
    if (behavior === 'hard-auth') throw new Error('401 unauthorized')
    if (behavior === 'hard-transient') {
      messages.push({ role: 'assistant', stopReason: 'error' })
      throw new Error('socket hang up')
    }
    if (behavior === 'soft-transient' || behavior === 'soft-overload') {
      messages.push({ role: 'assistant', stopReason: 'error' })
      const errorMessage = behavior === 'soft-overload' ? 'server_is_overloaded' : 'ECONNRESET'
      for (const cb of listeners)
        cb({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage } })
      return
    }
    messages.push({ role: 'assistant', stopReason: 'stop' })
  }
  const session = {
    subscribe: (cb: (event: { type: string; message?: unknown }) => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    prompt: async () => step(false),
    agent: {
      state: {
        get messages() {
          return messages
        },
        set messages(v: Array<{ role: string; stopReason?: string }>) {
          messages.length = 0
          messages.push(...v)
        },
      },
      continue: async () => step(true),
    },
  } as unknown as AgentSession
  return { session, userMessages: () => messages.filter((m) => m.role === 'user').length, attempts: () => idx }
}

describe('promptWithSameRefRetryOnly', () => {
  test('recovers a transient soft error via continue without duplicating the user message', async () => {
    const fake = promptFake(['soft-transient', 'success'])
    await promptWithSameRefRetryOnly(fake.session, 'hi')
    expect(fake.attempts()).toBe(2)
    expect(fake.userMessages()).toBe(1)
  })

  test('recovers a transient hard throw via continue', async () => {
    const fake = promptFake(['hard-transient', 'success'])
    await promptWithSameRefRetryOnly(fake.session, 'hi')
    expect(fake.attempts()).toBe(2)
    expect(fake.userMessages()).toBe(1)
  })

  test('propagates a non-retryable hard throw (bare-prompt semantics preserved)', async () => {
    const fake = promptFake(['hard-auth'])
    await expect(promptWithSameRefRetryOnly(fake.session, 'hi')).rejects.toThrow('401 unauthorized')
    expect(fake.attempts()).toBe(1)
  })

  test('does not retry when the first attempt succeeds', async () => {
    const fake = promptFake(['success'])
    await promptWithSameRefRetryOnly(fake.session, 'hi')
    expect(fake.attempts()).toBe(1)
  })

  test('rides out an overload on the default policy — there is no ref to fail over to', async () => {
    const fake = promptFake(['soft-overload', 'success'])
    const result = await promptWithSameRefRetryOnly(fake.session, 'hi', undefined, { overloadBackoffMs: () => 0 })
    expect(result.success).toBe(true)
    expect(fake.attempts()).toBe(2)
    expect(fake.userMessages()).toBe(1)
  })

  test('gives up on a sustained overload once the responsive budget is spent', async () => {
    const fake = promptFake(['soft-overload'])
    const result = await promptWithSameRefRetryOnly(fake.session, 'hi', undefined, { overloadBackoffMs: () => 0 })
    expect(result.success).toBe(false)
    expect(fake.attempts()).toBe(RESPONSIVE_OVERLOAD_RETRIES + 1)
  })

  test('surfaces the original hard error when the retry recipe cannot apply (no phantom success)', async () => {
    // given: a RETRYABLE hard throw, but the transcript leaf is an unsafe shape
    // (tool-result) so retryTurnOnPersistentSession fails closed and never replays
    const messages = [{ role: 'user' }, { role: 'toolResult' }]
    let promptCalls = 0
    let continueCalls = 0
    const session = {
      subscribe: () => () => {},
      prompt: async () => {
        promptCalls++
        throw new Error('socket hang up')
      },
      agent: {
        state: {
          get messages() {
            return messages
          },
          set messages(v: Array<{ role: string }>) {
            messages.length = 0
            messages.push(...v)
          },
        },
        continue: async () => {
          continueCalls++
        },
      },
    } as unknown as AgentSession

    // then: the original hard error propagates — it is NOT swallowed as success
    await expect(promptWithSameRefRetryOnly(session, 'hi')).rejects.toThrow('socket hang up')
    expect(promptCalls).toBe(1)
    expect(continueCalls).toBe(0) // unsafe leaf → continue() never runs
  })
})
