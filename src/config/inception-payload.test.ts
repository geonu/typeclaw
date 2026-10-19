import { describe, expect, test } from 'bun:test'

import { normalizeContext, type Context, type Model, type ThinkingLevel } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions'

import { KNOWN_PROVIDERS } from './providers'

// Drives pi-ai's real openai-completions adapter with the curated Mercury 3
// record and captures the request body via `onPayload`, which throws before any
// network I/O. Same pattern as upstage-payload.test.ts.
async function buildMercuryPayload(reasoning?: ThinkingLevel): Promise<Record<string, unknown>> {
  const model = KNOWN_PROVIDERS.inception.models['mercury-3'] as Model<'openai-completions'>
  const context: Context = {
    systemPrompt: 'You are a helpful assistant.',
    messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
  }

  let captured: Record<string, unknown> | undefined
  const s = streamSimple(model, normalizeContext(context), {
    apiKey: 'test-key',
    reasoning,
    onPayload: (payload) => {
      captured = payload as Record<string, unknown>
      throw new Error('payload-captured')
    },
  })
  for await (const _event of s) {
    if (captured !== undefined) break
  }

  if (captured === undefined) throw new Error('onPayload never fired — adapter path changed')
  return captured
}

describe('inception mercury-3 openai-completions payload', () => {
  test('sends reasoning_effort=instant when reasoning is off, overriding the upstream low default', async () => {
    const payload = await buildMercuryPayload(undefined)
    expect(payload.reasoning_effort).toBe('instant')
  })

  test('maps every pi reasoning level onto an effort Inception accepts', async () => {
    const expected: Record<string, string> = {
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
    }
    for (const [level, effort] of Object.entries(expected)) {
      const payload = await buildMercuryPayload(level as ThinkingLevel)
      expect(payload.reasoning_effort, `level ${level}`).toBe(effort)
    }
  })

  test('never sends store or the developer role', async () => {
    const payload = await buildMercuryPayload('medium')
    expect('store' in payload).toBe(false)
    const messages = (payload.messages ?? []) as Array<{ role: string }>
    for (const m of messages) expect(m.role).not.toBe('developer')
  })
})
