import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'
import { install } from '@sinonjs/fake-timers'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { invalidateProviderAuthCache } from './auth'
import { createSessionWithDispose } from './index'
import { LiveSubagentRegistry } from './live-subagents'

function completion(): Response {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'test-message',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1000 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('session lifecycle replays the final wire payload without appending messages or emitting replies', async () => {
  // Given a real SDK session and a running child owned by that parent.
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const previousKey = process.env.ANTHROPIC_API_KEY
  const agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-cache-keepalive-'))
  let clock: ReturnType<typeof install> | undefined
  let created: Awaited<ReturnType<typeof createSessionWithDispose>> | undefined
  try {
    process.chdir(agentDir)
    await writeFile(
      join(agentDir, 'typeclaw.json'),
      JSON.stringify({ models: { default: 'anthropic/claude-sonnet-4-5' } }),
    )
    reloadConfig(agentDir)
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key'
    invalidateProviderAuthCache()
    const manager = SessionManager.inMemory(agentDir)
    const registry = new LiveSubagentRegistry()
    registry.register({
      taskId: 'child',
      sessionId: 'child-session',
      parentSessionId: manager.getSessionId(),
      subagentName: 'worker',
      background: true,
      status: 'running',
      startedAt: 0,
      abort: async () => {},
    })
    created = await createSessionWithDispose({
      sessionManager: manager,
      systemPromptOverride: 'system fixture',
      tools: ['read', 'bash'],
      liveSubagentRegistry: registry,
      origin: { kind: 'tui', sessionId: manager.getSessionId() },
    })
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await new Request(input, init).json())
        return completion()
      },
      { preconnect: previousFetch.preconnect },
    )
    clock = install({ now: 0, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    let messageEvents = 0
    created.session.subscribe((event) => {
      if (event.type === 'message_end') messageEvents += 1
    })
    await created.session.prompt('task fixture')
    const transcript = structuredClone(manager.getEntries())
    const messages = structuredClone(created.session.messages)
    const eventCount = messageEvents
    expect(bodies).toHaveLength(1)
    expect(created.session.cacheWarmingStatus?.state).toBe('inactive')

    // When idle time reaches the pre-expiry deadline.
    await clock.tickAsync(270_000)

    // Then the real Anthropic adapter sends only an output-budget change, and
    // the response bypasses all agent/session/tool/channel dispatch.
    expect(bodies).toHaveLength(2)
    const { max_tokens: originalMax, ...originalPrefix } = bodies[0] ?? {}
    const { max_tokens: pingMax, ...pingPrefix } = bodies[1] ?? {}
    expect(originalPrefix.tools).toBeArray()
    expect(pingPrefix).toEqual(originalPrefix)
    expect(typeof pingMax).toBe('number')
    expect(Number(pingMax)).toBeLessThan(Number(originalMax))
    expect(manager.getEntries()).toEqual(transcript)
    expect(created.session.messages).toEqual(messages)
    expect(messageEvents).toBe(eventCount)

    // Completion and actual session disposal both stop future provider calls.
    registry.recordCompletionIfRunning('child', { ok: true, durationMs: 270_000 })
    await clock.tickAsync(270_000)
    expect(bodies).toHaveLength(2)
    registry.register({
      taskId: 'sibling',
      sessionId: 'sibling-session',
      parentSessionId: manager.getSessionId(),
      subagentName: 'worker',
      background: true,
      status: 'running',
      startedAt: clock.now,
      abort: async () => {},
    })
    created.session.dispose()
    await clock.tickAsync(270_000)
    expect(bodies).toHaveLength(2)
  } finally {
    created?.session.dispose()
    await created?.dispose()
    clock?.uninstall()
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = previousKey
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(agentDir, { recursive: true, force: true })
  }
})
