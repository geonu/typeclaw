import { describe, expect, test } from 'bun:test'

import type { StreamFn } from '@earendil-works/pi-agent-core'
import { normalizeContext } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/api/anthropic-messages'
import { getModel } from '@earendil-works/pi-ai/compat'
import { createClock } from '@sinonjs/fake-timers'

import { LiveSubagentRegistry } from './live-subagents'
import { MAX_SUBAGENT_CACHE_PINGS, SubagentCacheKeepalive } from './subagent-cache-keepalive'

const INTERVAL = 270_000
const model = getModel('anthropic', 'claude-sonnet-4-5')
const context = normalizeContext({
  systemPrompt: 'cache fixture',
  messages: [{ role: 'user', content: 'task fixture', timestamp: 0 }],
  tools: [
    { name: 'second', description: 'second fixture', parameters: { type: 'object', properties: {} } },
    { name: 'first', description: 'first fixture', parameters: { type: 'object', properties: {} } },
  ],
})
const payload = {
  model: model.id,
  system: [{ type: 'text', text: 'system fixture', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'second' }, { name: 'first' }],
  messages: [{ role: 'user', content: 'message fixture' }],
  max_tokens: 32_000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high' },
  prompt_cache_key: 'typeclaw:tui',
}

function harness() {
  const clock = createClock(0)
  const registry = new LiveSubagentRegistry()
  const requests: { model: unknown; context: unknown; payload: unknown; signal: AbortSignal | undefined }[] = []
  const logs: string[] = []
  let pending: (() => void) | undefined
  let hold = false
  let fail = false
  const stream: StreamFn = async (requestModel, requestContext, options) => {
    const body = await options?.onPayload?.({}, requestModel)
    requests.push({ model: requestModel, context: requestContext, payload: body, signal: options?.signal })
    if (fail) throw new TypeError('transport fixture failed')
    // Use the real provider stream/parser, with a controlled HTTP response.
    if (hold) await new Promise<void>((resolve) => (pending = resolve))
    return streamSimple(model, requestContext, {
      ...options,
      apiKey: 'test-key',
      fetch: Object.assign(
        async () =>
          new Response(
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: 'test-message',
                model: model.id,
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 },
              },
            })}\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
        { preconnect: () => {} },
      ),
    })
  }
  const keepalive = new SubagentCacheKeepalive(
    'parent',
    registry,
    stream,
    {
      now: () => clock.now,
      schedule: (callback, delay) => {
        const timer = clock.setTimeout(callback, delay)
        return () => clock.clearTimeout(timer)
      },
    },
    (line) => logs.push(line),
  )
  function child(taskId = 'child', parentSessionId = 'parent', background = true) {
    registry.register({
      taskId,
      sessionId: `${taskId}-session`,
      subagentName: 'worker',
      parentSessionId,
      background,
      status: 'running',
      startedAt: clock.now,
      abort: async () => {},
    })
  }
  function capture(
    requestModel: Parameters<StreamFn>[0] = model,
    body: unknown = payload,
    options: NonNullable<Parameters<StreamFn>[2]> = {},
  ) {
    keepalive.capture(requestModel, context, options, body)
  }
  function complete(taskId = 'child') {
    registry.recordCompletionIfRunning(taskId, { ok: true, durationMs: clock.now })
  }
  return {
    clock,
    registry,
    requests,
    logs,
    keepalive,
    child,
    capture,
    complete,
    hold: () => {
      hold = true
    },
    release: () => pending?.(),
    fail: () => {
      fail = true
    },
  }
}

describe('parent subagent cache keepalive', () => {
  test('pings shortly before expiry only after the parent settles', async () => {
    const h = harness()
    h.capture()
    h.child()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(0)
    h.keepalive.settle()
    await h.clock.tickAsync(0)
    expect(h.requests).toHaveLength(1)
    h.keepalive.close()
  })

  test('ignores foreground children and other parents', async () => {
    const h = harness()
    h.capture()
    h.child('foreground', 'parent', false)
    h.child('foreign', 'other')
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(0)
    h.child()
    await h.clock.tickAsync(0)
    expect(h.requests).toHaveLength(1)
    h.keepalive.close()
  })

  for (const stop of ['turn', 'completion', 'unregister', 'clear', 'close', 'invalidate'] as const) {
    test(`cancels the scheduled ping on ${stop}`, async () => {
      const h = harness()
      h.capture()
      h.child()
      h.keepalive.settle()
      if (stop === 'turn') h.keepalive.startTurn()
      if (stop === 'completion') h.complete()
      if (stop === 'unregister') h.registry.unregister('child')
      if (stop === 'clear') h.registry.clear()
      if (stop === 'close') h.keepalive.close()
      if (stop === 'invalidate') h.keepalive.invalidate()
      await h.clock.tickAsync(INTERVAL)
      expect(h.requests).toHaveLength(0)
      expect(h.clock.countTimers()).toBe(0)
      h.keepalive.close()
    })
  }

  for (const stop of ['turn', 'completion', 'clear', 'close'] as const) {
    test(`aborts an in-flight ping on ${stop}`, async () => {
      const h = harness()
      h.capture()
      h.child()
      h.hold()
      h.keepalive.settle()
      await h.clock.tickAsync(INTERVAL)
      expect(h.requests).toHaveLength(1)
      if (stop === 'turn') h.keepalive.startTurn()
      if (stop === 'completion') h.complete()
      if (stop === 'clear') h.registry.clear()
      if (stop === 'close') h.keepalive.close()
      expect(h.requests[0]?.signal?.aborted).toBe(true)
      h.release()
      await h.clock.tickAsync(INTERVAL)
      expect(h.requests).toHaveLength(1)
      h.keepalive.close()
    })
  }

  test('keeps warming until the last sibling completes', async () => {
    const h = harness()
    h.capture()
    h.child()
    h.child('sibling')
    h.keepalive.settle()
    h.complete()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(1)
    h.complete('sibling')
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(1)
    h.keepalive.close()
  })

  test('replays an immutable snapshot of the exact model, tools, messages and parameters', async () => {
    const h = harness()
    const original = structuredClone(payload)
    const captured = structuredClone(payload)
    h.capture(model, captured)
    captured.tools.reverse()
    const system = captured.system[0]
    if (system) system.text = 'changed fixture'
    h.child()
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests[0]?.model).toEqual(model)
    expect(h.requests[0]?.context).toEqual(context)
    expect(h.requests[0]?.payload).toEqual({ ...original, max_tokens: 1 })
    expect(h.requests[0]?.signal?.aborted).toBe(true)
    h.keepalive.close()
  })

  test('preserves legacy thinking budget while using its minimum valid output cap', async () => {
    const h = harness()
    const original = { ...payload, thinking: { type: 'enabled', budget_tokens: 4096 } }
    h.capture(model, original)
    h.child()
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests[0]?.payload).toEqual({ ...original, max_tokens: 4097 })
    expect(h.requests[0]?.signal?.aborted).toBe(true)
    h.keepalive.close()
  })

  for (const kind of ['openai', 'none', 'long', 'no-markers'] as const) {
    test(`skips ${kind} requests`, async () => {
      const h = harness()
      const requestModel = kind === 'openai' ? getModel('openai', 'gpt-4o-mini') : model
      const body =
        kind === 'long'
          ? { ...payload, system: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] }
          : kind === 'no-markers'
            ? {}
            : payload
      h.capture(requestModel, body, kind === 'none' ? { cacheRetention: 'none' } : {})
      h.child()
      h.keepalive.settle()
      await h.clock.tickAsync(INTERVAL * 2)
      expect(h.requests).toHaveLength(0)
      h.keepalive.close()
    })
  }

  test('caps each idle period and resets only on a real turn', async () => {
    const h = harness()
    h.capture()
    h.child()
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL * (MAX_SUBAGENT_CACHE_PINGS + 2))
    expect(h.requests).toHaveLength(MAX_SUBAGENT_CACHE_PINGS)
    expect(h.clock.countTimers()).toBe(0)
    h.keepalive.startTurn()
    h.capture()
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(MAX_SUBAGENT_CACHE_PINGS + 1)
    h.keepalive.close()
  })

  test('does not issue a cold write after a long parent turn', async () => {
    const h = harness()
    h.capture()
    h.child()
    await h.clock.tickAsync(300_000)
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(0)
    h.keepalive.close()
  })

  test('does not dispatch a delayed timer after the refresh deadline', async () => {
    const h = harness()
    h.capture()
    h.child()
    h.keepalive.settle()
    h.clock.setSystemTime(300_000)
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(0)
    h.keepalive.close()
  })

  test('logs failed pings only to the operator and does not retry them', async () => {
    const h = harness()
    h.capture()
    h.child()
    h.fail()
    h.keepalive.settle()
    await h.clock.tickAsync(INTERVAL)
    h.child('sibling')
    await h.clock.tickAsync(INTERVAL)
    expect(h.requests).toHaveLength(1)
    expect(h.logs).toHaveLength(2)
    expect(h.clock.countTimers()).toBe(0)
    h.keepalive.close()
  })
})
