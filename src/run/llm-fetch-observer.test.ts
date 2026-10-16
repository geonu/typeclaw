import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  AdaptiveTtfbTracker,
  defaultLlmFetchEndpoints,
  installLlmFetchObserver,
  LLM_FETCH_OBSERVER_TIMEOUTS,
  type LlmFetchObservedRequestInit,
  type TimeoutScheduler,
} from './llm-fetch-observer'

// Programmable scheduler for tests. Tasks scheduled for time T fire when the
// test calls `fire(T)`. Out-of-order T values (T must be monotonically
// non-decreasing across calls) are not supported; tests advance time forward.
function makeScheduler(): TimeoutScheduler & { fire: (t: number) => Promise<void>; pending: () => number } {
  type Entry = { id: number; dueAt: number; cb: () => void; cancelled: boolean }
  let counter = 0
  let nowMs = 0
  const entries: Entry[] = []
  return {
    set: (delayMs, cb) => {
      const e: Entry = { id: ++counter, dueAt: nowMs + delayMs, cb, cancelled: false }
      entries.push(e)
      return e
    },
    clear: (handle) => {
      const e = handle as Entry
      e.cancelled = true
    },
    fire: async (t) => {
      nowMs = t
      const flush = () => new Promise<void>((r) => queueMicrotask(r))
      while (true) {
        const due = entries.find((e) => !e.cancelled && e.dueAt <= t)
        if (!due) break
        due.cancelled = true
        due.cb()
        await flush()
        await flush()
      }
    },
    pending: () => entries.filter((e) => !e.cancelled).length,
  }
}

type LogEntry = { level: 'info' | 'warn'; msg: string }

function captureLogger(): { logger: { info: (m: string) => void; warn: (m: string) => void }; entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    logger: {
      info: (m) => entries.push({ level: 'info', msg: m }),
      warn: (m) => entries.push({ level: 'warn', msg: m }),
    },
  }
}

// Programmable clock so phase timings are deterministic. `now()` returns
// whatever the test most recently set; production reads timings via the
// `now` option, so we never depend on real wall-clock in assertions.
function makeClock() {
  let ms = 0
  return {
    now: () => ms,
    set: (v: number) => {
      ms = v
    },
  }
}

// Body controller pair: lets the test push chunks/close/error into a Response
// body at the moments it chooses, after walking the clock to the right value.
// More predictable than a self-scheduling fake because each event awaits a
// microtask flush before the next test step assertion.
function makeControllableBody(): {
  body: ReadableStream<Uint8Array>
  push: (data: Uint8Array) => Promise<void>
  close: () => Promise<void>
  error: (err: Error) => Promise<void>
} {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  let resolveReady!: (c: ReadableStreamDefaultController<Uint8Array>) => void
  const ready = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
    resolveReady = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      resolveReady(controller)
    },
  })
  const flush = () => new Promise<void>((r) => queueMicrotask(r))
  return {
    body,
    push: async (data) => {
      const c = controllerRef ?? (await ready)
      c.enqueue(data)
      await flush()
      await flush()
    },
    close: async () => {
      const c = controllerRef ?? (await ready)
      c.close()
      await flush()
    },
    error: async (err) => {
      const c = controllerRef ?? (await ready)
      c.error(err)
      await flush()
    },
  }
}

// Drain a readable stream to completion, ignoring chunks. Lets us trigger the
// observer's final log without caring about what the SSE consumer would do.
async function drainQuiet(stream: ReadableStream<Uint8Array> | null): Promise<void> {
  if (stream === null) return
  const reader = stream.getReader()
  try {
    while (true) {
      const { done } = await reader.read()
      if (done) break
    }
  } catch {
    // expected for error-stream tests
  }
}

const originalFetch = globalThis.fetch

describe('installLlmFetchObserver', () => {
  const clearObserverEnv = () => {
    delete process.env.TYPECLAW_CODEX_TIMEOUTS
    delete process.env.TYPECLAW_CODEX_TTFB_MS
    delete process.env.TYPECLAW_CODEX_IDLE_MS
    delete process.env.TYPECLAW_CODEX_OVERALL_MS
    delete process.env.TYPECLAW_CODEX_FETCH_OBSERVER
    delete process.env.TYPECLAW_LLM_TIMEOUTS
    delete process.env.TYPECLAW_LLM_TTFB_MS
    delete process.env.TYPECLAW_LLM_IDLE_MS
    delete process.env.TYPECLAW_LLM_OVERALL_MS
    delete process.env.TYPECLAW_LLM_FETCH_OBSERVER
  }

  beforeEach(() => {
    globalThis.fetch = originalFetch
    clearObserverEnv()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearObserverEnv()
  })

  test('passes non-Codex requests through unchanged (no wrapping)', async () => {
    const { logger, entries } = captureLogger()
    const sentinel = Symbol('upstream')
    globalThis.fetch = (async () => sentinel as unknown as Response) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger })
    try {
      const result = await fetch('https://example.com/some/other/path')
      expect(result).toBe(sentinel as unknown as Response)
      expect(entries).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('propagates errors from non-Codex upstream verbatim', async () => {
    const { logger, entries } = captureLogger()
    const upstreamError = new Error('upstream boom')
    globalThis.fetch = (async () => {
      throw upstreamError
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger })
    try {
      await expect(fetch('https://api.openai.com/v1/responses')).rejects.toBe(upstreamError)
      expect(entries).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('logs phase timings for a Codex request', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(50)
      return new Response(ctrl.body, {
        status: 200,
        headers: { 'x-request-id': 'req_abc123', 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const responsePromise = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const response = await responsePromise
      expect(response.status).toBe(200)
      const drainPromise = drainQuiet(response.body)
      clock.set(200)
      await ctrl.push(new TextEncoder().encode('data: {"type":"response.created"}\n\n'))
      clock.set(1500)
      await ctrl.push(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'))
      clock.set(2000)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    const line = observed[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('seq=1')
    expect(line).toContain('headers_ms=50')
    expect(line).toContain('first_byte_ms=200')
    expect(line).toContain('total_ms=2000')
    expect(line).toContain('request_id=req_abc123')
    expect(line).toContain('retry_after=null')
    expect(line).toContain('error=null')
  })

  test('seq increments per provider|origin so retry multiplication is countable', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()

    globalThis.fetch = (async () => {
      const ctrl = makeControllableBody()
      queueMicrotask(() => void ctrl.close())
      return new Response(ctrl.body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      for (let i = 0; i < 3; i++) {
        const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
        await drainQuiet(response.body)
      }
    } finally {
      uninstall()
    }

    const lines = entries.filter((e) => e.msg.startsWith('[llm-fetch]')).map((e) => e.msg)
    expect(lines.map((m) => Number(m.match(/ seq=(\d+)/)![1]))).toEqual([1, 2, 3])
    for (const line of lines) expect(line).toContain('origin=https://chatgpt.com')
  })

  test('seq is scoped per origin so a shared provider label does not collide', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()

    globalThis.fetch = (async () => {
      const ctrl = makeControllableBody()
      queueMicrotask(() => void ctrl.close())
      return new Response(ctrl.body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch

    // Two distinct proxy origins that both match the `openai-compatible` label.
    // Interleaved, each origin must keep its OWN seq (1,2), not a shared 1..4.
    const urlA = 'https://proxy-a.example/v1/chat/completions'
    const urlB = 'https://proxy-b.example/v1/chat/completions'
    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      for (const url of [urlA, urlB, urlA, urlB]) {
        const response = await fetch(url, { method: 'POST' })
        await drainQuiet(response.body)
      }
    } finally {
      uninstall()
    }

    const parse = (host: string) =>
      entries
        .filter((e) => e.msg.startsWith('[llm-fetch]') && e.msg.includes(`origin=https://${host}`))
        .map((e) => Number(e.msg.match(/ seq=(\d+)/)![1]))
    expect(parse('proxy-a.example')).toEqual([1, 2])
    expect(parse('proxy-b.example')).toEqual([1, 2])
  })

  test('logs retry_after header when present (throttling signal)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(10)
      return new Response(ctrl.body, {
        status: 429,
        headers: { 'retry-after': '42', 'x-request-id': 'req_throttled' },
      })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(20)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('status=429')
    expect(observed[0]!.msg).toContain('retry_after=42')
  })

  test('logs stream errors with error message and partial timings', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(30)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(100)
      await ctrl.push(new TextEncoder().encode('data: hi\n\n'))
      clock.set(300)
      await ctrl.error(new Error('connection reset by peer'))
      await drainPromise
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    const line = observed[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('first_byte_ms=100')
    expect(line).toContain('error="connection reset by peer"')
  })

  test('logs fetch() rejection (pre-response error)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    globalThis.fetch = (async () => {
      clock.set(500)
      throw new Error('fetch failed')
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      await expect(fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })).rejects.toThrow(
        'fetch failed',
      )
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('error="fetch failed"')
    expect(observed[0]!.msg).toContain('headers_ms=null')
    expect(observed[0]!.msg).toContain('first_byte_ms=null')
    expect(observed[0]!.msg).toMatch(/total_ms=\d+/)
  })

  test('matches Codex URL by host and path, ignores other paths on same host', async () => {
    const { logger, entries } = captureLogger()
    const sentinel = new Response(null, { status: 204 })
    globalThis.fetch = (async () => sentinel) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger })
    try {
      const result = await fetch('https://chatgpt.com/backend-api/me')
      expect(result).toBe(sentinel)
      expect(entries.filter((e) => e.msg.startsWith('[llm-fetch]'))).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('uninstall restores original fetch', () => {
    const { logger } = captureLogger()
    const before = globalThis.fetch
    const uninstall = installLlmFetchObserver({ logger })
    expect(globalThis.fetch).not.toBe(before)
    uninstall()
    expect(globalThis.fetch).toBe(before)
  })

  test('a second install shares the wrapper and is ref-counted: a later release keeps fetch observed while another claimant remains', () => {
    const { logger } = captureLogger()
    const before = globalThis.fetch
    const release1 = installLlmFetchObserver({ logger })
    const wrappedAfterFirst = globalThis.fetch
    const release2 = installLlmFetchObserver({ logger })
    try {
      // given two claimants sharing one wrapper
      expect(globalThis.fetch).toBe(wrappedAfterFirst)

      // when the second claimant releases (e.g. a second agent's boot-failure
      // cleanup), the first agent's observer must survive
      release2()
      expect(globalThis.fetch).toBe(wrappedAfterFirst)

      // then only the final release restores the original fetch
      release1()
      expect(globalThis.fetch).toBe(before)
    } finally {
      release1()
      release2()
    }
  })

  test('a release is idempotent and never tears down a re-acquired observer', () => {
    const { logger } = captureLogger()
    const before = globalThis.fetch
    const release1 = installLlmFetchObserver({ logger })
    release1()
    release1() // idempotent: second call is a no-op
    expect(globalThis.fetch).toBe(before)

    // a fresh install after full release re-wraps and is independent
    const release2 = installLlmFetchObserver({ logger })
    expect(globalThis.fetch).not.toBe(before)
    // the stale release1 must NOT restore over the new observer
    release1()
    expect(globalThis.fetch).not.toBe(before)
    release2()
    expect(globalThis.fetch).toBe(before)
  })

  test('TYPECLAW_CODEX_FETCH_OBSERVER=off disables installation', () => {
    const { logger, entries } = captureLogger()
    const before = globalThis.fetch
    process.env.TYPECLAW_CODEX_FETCH_OBSERVER = 'off'
    try {
      const uninstall = installLlmFetchObserver({ logger })
      expect(globalThis.fetch).toBe(before)
      uninstall()
      expect(globalThis.fetch).toBe(before)
      expect(entries.filter((e) => e.msg.startsWith('[llm-fetch]'))).toEqual([])
    } finally {
      delete process.env.TYPECLAW_CODEX_FETCH_OBSERVER
    }
  })

  test('observes an arbitrary Anthropic proxy host by /v1/messages path suffix', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now })
    try {
      clock.set(0)
      const response = await fetch('https://proxy.example.com/anthropic/v1/messages', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(20)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('provider=anthropic')
  })

  test('matches Anthropic, OpenAI-compatible, and Codex paths; ignores GET and unrelated paths', async () => {
    const { logger, entries } = captureLogger()
    const sentinel = new Response(null, { status: 204 })
    globalThis.fetch = (async () => sentinel) as unknown as typeof fetch

    const matchCases: Array<{ url: string; provider: string }> = [
      { url: 'https://api.anthropic.com/v1/messages', provider: 'anthropic' },
      { url: 'https://proxy.internal/gateway/anthropic/v1/messages', provider: 'anthropic' },
      { url: 'https://api.openai.com/v1/chat/completions', provider: 'openai-compatible' },
      { url: 'https://api.fireworks.ai/inference/v1/chat/completions', provider: 'openai-compatible' },
      { url: 'https://litellm.internal/chat/completions', provider: 'openai-compatible' },
      { url: 'https://api.openai.com/v1/responses', provider: 'openai-compatible' },
      { url: 'https://chatgpt.com/backend-api/codex/responses', provider: 'codex' },
    ]

    const uninstall = installLlmFetchObserver({ logger, ttfbMs: 0, idleMs: 0, overallMs: 0 })
    try {
      for (const { url, provider } of matchCases) {
        entries.length = 0
        await fetch(url, { method: 'POST' })
        const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
        expect(observed.length, `expected ${url} to be observed`).toBe(1)
        expect(observed[0]!.msg).toContain(`provider=${provider}`)
      }

      // given a GET to a matching path and a POST to an unrelated path
      entries.length = 0
      await fetch('https://api.anthropic.com/v1/messages', { method: 'GET' })
      await fetch('https://api.anthropic.com/v1/models', { method: 'POST' })
      expect(entries.filter((e) => e.msg.startsWith('[llm-fetch]'))).toEqual([])
    } finally {
      uninstall()
    }
  })

  test('idle timeout aborts a stalled Anthropic proxy stream (the production silent-hang)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 100 })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://proxy.example.com/anthropic/v1/messages', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(105)
      await scheduler.fire(105)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('anthropic SSE body idle for 100ms')

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('provider=anthropic')
    expect(observed[0]!.msg).toContain('cause=idle_timeout')
  })

  test('a fast 429 JSON error body passes through and logs without tripping a timeout', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    const jsonBody = new TextEncoder().encode(
      '{"error":{"type":"rate_limit_error","message":"All tokens rate limited"}}',
    )
    globalThis.fetch = (async () => {
      clock.set(8)
      return new Response(jsonBody, { status: 429, headers: { 'retry-after': '30' } })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 100, overallMs: 200 })
    let status: number | null = null
    let text = ''
    try {
      clock.set(0)
      const response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })
      status = response.status
      clock.set(12)
      text = await response.text()
    } finally {
      uninstall()
    }

    expect(status).toBe(429)
    expect(text).toContain('All tokens rate limited')
    expect(scheduler.pending()).toBe(0)
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('provider=anthropic')
    expect(observed[0]!.msg).toContain('status=429')
    expect(observed[0]!.msg).toContain('retry_after=30')
    expect(observed[0]!.msg).toContain('cause=null')
    expect(observed[0]!.msg).toContain('error=null')
  })

  test('TTFB timeout aborts pending fetch with a retryable error message', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    let underlyingSignal: AbortSignal | undefined
    let fetchRejection: Promise<never> | null = null
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      fetchRejection = new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      })
      return fetchRejection as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 50, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      clock.set(50)
      await scheduler.fire(50)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('timed out')
    expect(caught!.message).toContain('50ms')
    expect(underlyingSignal?.aborted).toBe(true)

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    const line = observed[0]!.msg
    expect(line).toContain('provider=codex')
    expect(line).toContain('status=null')
    expect(line).toContain('headers_ms=null')
    expect(line).toContain('first_byte_ms=null')
    expect(line).toContain('total_ms=50')
    expect(line).toContain('cause=ttfb_timeout')
    expect(line).toMatch(/error="codex fetch timed out before response headers after 50ms.*"/)
  })

  test('TTFB timer is cancelled once headers arrive (healthy fast turn)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(10)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 1000, idleMs: 0 })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(50)
      await ctrl.push(new TextEncoder().encode('hi'))
      clock.set(100)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(scheduler.pending()).toBe(0)
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('status=200')
    expect(observed[0]!.msg).toContain('cause=null')
    expect(observed[0]!.msg).toContain('error=null')
  })

  test('TTFB composes with caller-provided AbortSignal (caller abort still wins)', async () => {
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    const callerController = new AbortController()
    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 60000, idleMs: 0 })
    let caught: Error | null = null
    try {
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        signal: callerController.signal,
      })
      callerController.abort(new Error('user pressed escape'))
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toBe('user pressed escape')
    expect(underlyingSignal?.aborted).toBe(true)
  })

  test('Idle timeout aborts body reader when no chunks arrive within the window', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 100 })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(105)
      await scheduler.fire(105)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('idle for 100ms')

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    const line = observed[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('cause=idle_timeout')
    expect(line).toMatch(/error=".*idle for 100ms.*"/)
  })

  test('Idle timer resets on every chunk', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 100 })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(80)
      await ctrl.push(new TextEncoder().encode('chunk1'))
      clock.set(160)
      await ctrl.push(new TextEncoder().encode('chunk2'))
      clock.set(240)
      await ctrl.push(new TextEncoder().encode('chunk3'))
      clock.set(300)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('cause=null')
    expect(observed[0]!.msg).toContain('error=null')
    expect(observed[0]!.msg).toContain('body_bytes=18')
  })

  test('Overall deadline aborts a slow-trickle stream that never trips the idle timer', async () => {
    // Reproduces typeclaw issue #394's slow-trickle hang: the body keeps
    // emitting bytes inside the inter-chunk idle window (so the sliding idle
    // timer re-arms forever) but never reaches a terminal SSE event. With only
    // TTFB + idle timers, such a stream occupies the turn until Bun's OS socket
    // deadline fires (~900s observed in production). The overall deadline is the
    // absolute wall-clock ceiling that catches exactly this class.
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    // idleMs=100 (small) but each chunk lands inside it, so idle never trips.
    // overallMs=250 is exceeded while chunks are still trickling.
    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 100,
      overallMs: 250,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      // Trickle chunks every 80ms — always inside the 100ms idle window, so the
      // idle timer keeps resetting and would never fire on its own.
      clock.set(80)
      await ctrl.push(new TextEncoder().encode('chunk1'))
      clock.set(160)
      await ctrl.push(new TextEncoder().encode('chunk2'))
      clock.set(240)
      await ctrl.push(new TextEncoder().encode('chunk3'))
      // Cross the overall deadline (250ms from request start) before the next chunk.
      clock.set(260)
      await scheduler.fire(260)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    const line = observed[0]!.msg
    expect(line).toContain('status=200')
    expect(line).toContain('cause=overall_timeout')
    expect(line).toMatch(/error=".*overall deadline.*"/)
  })

  test('Overall deadline counts time spent waiting for headers (measured from fetch start)', async () => {
    // The ceiling is "from fetch start to body completion", so a slow-headers
    // request must NOT receive a fresh full overallMs for its body. Headers
    // arrive at t=200 with overallMs=250, leaving only 50ms of body budget — the
    // body must abort at t=250, not at t=450 (which a body-only timer would give).
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(200)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 250,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(250)
      await scheduler.fire(250)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed[0]!.msg).toContain('cause=overall_timeout')
  })

  test('Overall deadline aborts immediately when the budget is already spent on headers', async () => {
    // Headers arrive at t=300 with overallMs=250 — the budget is exhausted
    // before the body starts. The remainder clamps to 0, so the body aborts on
    // the very next tick rather than getting any additional time.
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(300)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 250,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(300)
      await scheduler.fire(300)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed[0]!.msg).toContain('cause=overall_timeout')
  })

  test('Idle abort listener count stays bounded across many chunks (no leak)', async () => {
    // given: a stream that will emit 100 chunks with a long idle window. The
    // pre-fix shape called `idleController.signal.addEventListener('abort', …)`
    // inside the per-iteration `Promise.race`, leaking one closure per chunk
    // when `reader.read()` won. The fix shares one listener across the whole
    // stream, so listener installations across N chunks must stay at <= 1.
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    const RealAbortController = globalThis.AbortController
    let installedAbortListeners = 0
    class CountingAbortController extends RealAbortController {
      constructor() {
        super()
        const realAdd = this.signal.addEventListener.bind(this.signal)
        this.signal.addEventListener = ((
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: AddEventListenerOptions | boolean,
        ) => {
          if (type === 'abort') installedAbortListeners += 1
          return realAdd(type, listener, options)
        }) as typeof this.signal.addEventListener
      }
    }
    globalThis.AbortController = CountingAbortController as unknown as typeof AbortController

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 10_000 })
    try {
      // when: 100 chunks flow through, each one comfortably inside the idle window
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      const chunk = new TextEncoder().encode('x')
      for (let i = 0; i < 100; i++) {
        clock.set(10 + i)
        await ctrl.push(chunk)
      }
      clock.set(200)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
      globalThis.AbortController = RealAbortController
    }

    // then: only the single shared listener should ever be installed across
    // the full lifetime of the stream, regardless of chunk count
    expect(installedAbortListeners).toBeLessThanOrEqual(1)
  })

  test('TYPECLAW_CODEX_TIMEOUTS=off disables timeouts but keeps observer active', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    process.env.TYPECLAW_CODEX_TIMEOUTS = 'off'
    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 50, idleMs: 50 })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(10000)
      await ctrl.push(new TextEncoder().encode('x'))
      clock.set(20000)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(scheduler.pending()).toBe(0)
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('status=200')
    expect(observed[0]!.msg).toContain('cause=null')
  })

  test('TYPECLAW_CODEX_TTFB_MS env var overrides default', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    process.env.TYPECLAW_CODEX_TTFB_MS = '250'
    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      clock.set(250)
      await scheduler.fire(250)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('250ms')

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed[0]!.msg).toContain('total_ms=250')
    expect(observed[0]!.msg).toContain('cause=ttfb_timeout')
  })

  test('Overall deadline fires even when the idle timer is disabled', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 200,
    })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(210)
      await scheduler.fire(210)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('overall deadline')
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed[0]!.msg).toContain('cause=overall_timeout')
  })

  test('overallMs=0 disables the overall deadline (stream may run unbounded)', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      ttfbMs: 0,
      idleMs: 0,
      overallMs: 0,
    })
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const drainPromise = drainQuiet(response.body)
      clock.set(1_000_000)
      await ctrl.push(new TextEncoder().encode('late'))
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    expect(scheduler.pending()).toBe(0)
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed[0]!.msg).toContain('cause=null')
    expect(observed[0]!.msg).toContain('error=null')
  })

  test('TYPECLAW_CODEX_OVERALL_MS env var overrides default', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    process.env.TYPECLAW_CODEX_OVERALL_MS = '300'
    globalThis.fetch = (async () => {
      clock.set(5)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, ttfbMs: 0, idleMs: 0 })
    let drainErr: Error | null = null
    try {
      clock.set(0)
      const response = await fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      const reader = response.body!.getReader()
      const drainPromise = (async () => {
        try {
          while (true) {
            const { done } = await reader.read()
            if (done) break
          }
        } catch (e) {
          drainErr = e as Error
        }
      })()
      clock.set(305)
      await scheduler.fire(305)
      await drainPromise
    } finally {
      uninstall()
    }

    expect(drainErr).not.toBeNull()
    expect(drainErr!.message).toContain('300ms')
    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed[0]!.msg).toContain('cause=overall_timeout')
  })

  test('an unset TYPECLAW_CODEX_*_MS pins codex ttfb to 13s and leaves idle/overall deferring', () => {
    const codex = defaultLlmFetchEndpoints({}).find((e) => e.label === 'codex')
    expect(codex).toBeDefined()
    // ttfb is pinned to the codex-specific 13s default (fast silent-hang detection,
    // adaptation bypassed); idle/overall still defer to generic/built-in defaults.
    expect(codex!.ttfbMs).toBe(13_000)
    expect(codex!.idleMs).toBeUndefined()
    expect(codex!.overallMs).toBeUndefined()
  })

  test('a set TYPECLAW_CODEX_*_MS pins the codex endpoint override', () => {
    const codex = defaultLlmFetchEndpoints({
      TYPECLAW_CODEX_TTFB_MS: '111',
      TYPECLAW_CODEX_IDLE_MS: '222',
      TYPECLAW_CODEX_OVERALL_MS: '333',
    }).find((e) => e.label === 'codex')
    expect(codex!.ttfbMs).toBe(111)
    expect(codex!.idleMs).toBe(222)
    expect(codex!.overallMs).toBe(333)
  })

  test('codex ttfb 13s default wins over a generic TYPECLAW_LLM_TTFB_MS when codex var is unset', async () => {
    // given: only the generic var is set (to a LONGER 20s). Codex must NOT defer to
    // it — the codex-specific 13s pin is what protects against silent hangs, so it
    // fires first regardless of a longer generic value.
    process.env.TYPECLAW_LLM_TTFB_MS = '20000'
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      clock.set(13_000)
      await scheduler.fire(13_000)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    // then: the 13s codex TTFB fired, not the 20s generic one
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('13000ms')
    expect(entries.find((e) => e.msg.startsWith('[llm-fetch]'))!.msg).toContain('cause=ttfb_timeout')
  })

  test('TYPECLAW_CODEX_TTFB_MS overrides the generic TYPECLAW_LLM_TTFB_MS for Codex', async () => {
    // given: both vars set; the Codex-specific one must win for the codex endpoint
    process.env.TYPECLAW_LLM_TTFB_MS = '70'
    process.env.TYPECLAW_CODEX_TTFB_MS = '40'
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' })
      clock.set(40)
      await scheduler.fire(40)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    // then: the 40ms Codex-specific TTFB fired, not the 70ms generic one
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('40ms')
  })

  test('a per-request TTFB override beats the endpoint default on the SAME url', async () => {
    // given: generic default TTFB is 50ms, but this ONE request carries a 500ms
    // per-request override (the GLM-vision path on a URL it shares with GLM text)
    process.env.TYPECLAW_LLM_TTFB_MS = '50'
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    let firedAt50 = false
    let caught: Error | null = null
    const init: LlmFetchObservedRequestInit = { method: 'POST', [LLM_FETCH_OBSERVER_TIMEOUTS]: { ttfbMs: 500 } }
    try {
      clock.set(0)
      const pending = fetch('https://api.z.ai/api/coding/paas/v4/chat/completions', init)
      // the endpoint default would have fired here; the override must suppress it
      clock.set(50)
      await scheduler.fire(50)
      firedAt50 = underlyingSignal?.aborted ?? false
      clock.set(500)
      await scheduler.fire(500)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    expect(firedAt50).toBe(false)
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('500ms')
  })

  test('an identical url WITHOUT the override still uses the endpoint default (GLM text stays aggressive)', async () => {
    // given: same z.ai coding URL as vision, but no per-request override
    process.env.TYPECLAW_LLM_TTFB_MS = '50'
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()

    let underlyingSignal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      underlyingSignal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        underlyingSignal?.addEventListener('abort', () => reject(underlyingSignal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch('https://api.z.ai/api/coding/paas/v4/chat/completions', { method: 'POST' })
      clock.set(50)
      await scheduler.fire(50)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }

    // then: the 50ms default fired — the override mechanism did not loosen text
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('50ms')
  })

  test('a per-request override still gets the body-timing tap + log on a healthy response', async () => {
    const { logger, entries } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const ctrl = makeControllableBody()

    globalThis.fetch = (async () => {
      clock.set(10)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({ logger, now: clock.now, scheduler, idleMs: 0 })
    const init: LlmFetchObservedRequestInit = { method: 'POST', [LLM_FETCH_OBSERVER_TIMEOUTS]: { ttfbMs: 500 } }
    try {
      clock.set(0)
      const response = await fetch('https://api.z.ai/api/coding/paas/v4/chat/completions', init)
      const drainPromise = drainQuiet(response.body)
      clock.set(50)
      await ctrl.push(new TextEncoder().encode('ok'))
      clock.set(100)
      await ctrl.close()
      await drainPromise
    } finally {
      uninstall()
    }

    const observed = entries.filter((e) => e.msg.startsWith('[llm-fetch]'))
    expect(observed.length).toBe(1)
    expect(observed[0]!.msg).toContain('status=200')
    expect(observed[0]!.msg).toContain('provider=openai-compatible')
  })
})

describe('AdaptiveTtfbTracker', () => {
  const FLOOR = 30_000
  const CEIL = 60_000
  const KEY = 'openai-compatible|https://api.z.ai'
  const OTHER = 'openai-compatible|https://api.fireworks.ai'
  // 2x31s = 62s clamps to the 60s ceil, so this seed reliably exercises the cap.
  const CEIL_SEED = 31_000

  function seedSamples(tracker: AdaptiveTtfbTracker, key: string, count: number, headersMs: number): void {
    for (let i = 0; i < count; i++) tracker.recordHeaders(key, headersMs)
  }

  test('stays at floor with fewer than the minimum samples', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    seedSamples(tracker, KEY, 7, 12_000)
    expect(tracker.resolve(KEY)).toBe(FLOOR)
  })

  test('raises the budget from p95 once enough samples exist, capped at ceil', () => {
    // given: 8 fast samples + one 20s spike → p95 is the spike, 2x = 40s
    const tracker = new AdaptiveTtfbTracker(() => 0)
    seedSamples(tracker, KEY, 8, 1_000)
    tracker.recordHeaders(KEY, 20_000)
    expect(tracker.resolve(KEY)).toBe(40_000)
  })

  test('never widens above the ceil even for a very slow p95', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    seedSamples(tracker, KEY, 12, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(CEIL)
  })

  test('samples expire after the rolling window and the budget returns to floor', () => {
    let now = 0
    const tracker = new AdaptiveTtfbTracker(() => now)
    seedSamples(tracker, KEY, 12, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(CEIL)
    now = 5 * 60_000 + 1
    expect(tracker.resolve(KEY)).toBe(FLOOR)
  })

  test('does not share state across origins', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    seedSamples(tracker, KEY, 12, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(CEIL)
    expect(tracker.resolve(OTHER)).toBe(FLOOR)
  })

  test('a below-ceil timeout grants exactly one ceil recovery probe', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    tracker.recordTimeout(KEY, FLOOR)
    expect(tracker.resolve(KEY)).toBe(CEIL)
    // grant consumed: the next resolve falls back to the learned floor
    expect(tracker.resolve(KEY)).toBe(FLOOR)
  })

  test('a probe success becomes a real sample that can widen the budget', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    seedSamples(tracker, KEY, 8, 1_000)
    tracker.recordTimeout(KEY, FLOOR)
    expect(tracker.resolve(KEY)).toBe(CEIL) // probe granted
    tracker.recordHeaders(KEY, CEIL_SEED) // probe observed a genuinely-slow header
    expect(tracker.resolve(KEY)).toBe(CEIL) // 2x31s clamped to ceil, now learned
  })

  test('a ceil timeout fails closed to floor and suppresses widening', () => {
    let now = 0
    const tracker = new AdaptiveTtfbTracker(() => now)
    seedSamples(tracker, KEY, 12, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(CEIL)
    tracker.recordTimeout(KEY, CEIL)
    expect(tracker.resolve(KEY)).toBe(FLOOR)
    // still suppressed within the cooldown window even with a fresh slow sample
    now = 4 * 60_000
    tracker.recordHeaders(KEY, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(FLOOR)
    // cooldown elapsed and the origin is still measurably slow → widening resumes
    now = 5 * 60_000 + 1
    seedSamples(tracker, KEY, 8, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(CEIL)
  })

  test('a ceil timeout revokes an outstanding probe grant', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    tracker.recordTimeout(KEY, FLOOR) // grant a probe
    tracker.recordTimeout(KEY, CEIL) // ...then fail closed
    expect(tracker.resolve(KEY)).toBe(FLOOR)
  })

  test('a sub-floor success clears fail-closed suppression early', () => {
    let now = 0
    const tracker = new AdaptiveTtfbTracker(() => now)
    seedSamples(tracker, KEY, 12, CEIL_SEED)
    tracker.recordTimeout(KEY, CEIL)
    expect(tracker.resolve(KEY)).toBe(FLOOR)
    now = 1_000
    tracker.recordHeaders(KEY, 900) // provider recovered
    expect(tracker.resolve(KEY)).toBe(CEIL)
  })

  test('reset clears all learned state', () => {
    const tracker = new AdaptiveTtfbTracker(() => 0)
    seedSamples(tracker, KEY, 12, CEIL_SEED)
    expect(tracker.resolve(KEY)).toBe(CEIL)
    tracker.reset()
    expect(tracker.resolve(KEY)).toBe(FLOOR)
  })
})

describe('adaptive TTFB integration through installLlmFetchObserver', () => {
  const URL = 'https://api.z.ai/api/coding/paas/v4/chat/completions'
  const FLOOR = 30_000

  const clearAdaptiveEnv = () => {
    delete process.env.TYPECLAW_LLM_TTFB_MS
    delete process.env.TYPECLAW_LLM_TIMEOUTS
    delete process.env.TYPECLAW_LLM_FETCH_OBSERVER
  }
  beforeEach(() => {
    globalThis.fetch = originalFetch
    clearAdaptiveEnv()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    clearAdaptiveEnv()
  })

  test('arms the adaptive budget (not the floor) when the origin is known-slow', async () => {
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const tracker = new AdaptiveTtfbTracker(clock.now)
    for (let i = 0; i < 12; i++) tracker.recordHeaders('openai-compatible|https://api.z.ai', 31_000)

    let signal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      idleMs: 0,
      adaptiveTracker: tracker,
    })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch(URL, { method: 'POST' })
      // floor (30s) must NOT fire; only the widened 60s budget aborts
      clock.set(FLOOR)
      await scheduler.fire(FLOOR)
      expect(signal?.aborted).toBe(false)
      clock.set(60_000)
      await scheduler.fire(60_000)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('60000ms')
  })

  test('records a successful headers sample so the origin can later widen', async () => {
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const tracker = new AdaptiveTtfbTracker(clock.now)

    let ctrl = makeControllableBody()
    globalThis.fetch = (async () => {
      clock.set(31_000)
      return new Response(ctrl.body, { status: 200 })
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      idleMs: 0,
      adaptiveTracker: tracker,
    })
    try {
      for (let i = 0; i < 12; i++) {
        ctrl = makeControllableBody()
        clock.set(0)
        const response = await fetch(URL, { method: 'POST' })
        const drainPromise = drainQuiet(response.body)
        clock.set(31_000)
        await ctrl.close()
        await drainPromise
      }
      expect(tracker.resolve('openai-compatible|https://api.z.ai')).toBe(60_000)
    } finally {
      uninstall()
    }
  })

  test('an explicit static TTFB override disables adaptation entirely', async () => {
    const { logger } = captureLogger()
    const clock = makeClock()
    const scheduler = makeScheduler()
    const tracker = new AdaptiveTtfbTracker(clock.now)
    for (let i = 0; i < 12; i++) tracker.recordHeaders('openai-compatible|https://api.z.ai', 14_000)

    let signal: AbortSignal | undefined
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }) as unknown as Response
    }) as unknown as typeof fetch

    const uninstall = installLlmFetchObserver({
      logger,
      now: clock.now,
      scheduler,
      idleMs: 0,
      ttfbMs: 5_000,
      adaptiveTracker: tracker,
    })
    let caught: Error | null = null
    try {
      clock.set(0)
      const pending = fetch(URL, { method: 'POST' })
      clock.set(5_000)
      await scheduler.fire(5_000)
      await pending.catch((e) => {
        caught = e
      })
    } finally {
      uninstall()
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('5000ms')
  })
})
