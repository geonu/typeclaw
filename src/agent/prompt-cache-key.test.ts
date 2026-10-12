import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeContext } from '@earendil-works/pi-ai'
import { SessionManager } from '@earendil-works/pi-coding-agent'

import { __resetConfigForTesting, reloadConfig } from '@/config/config'

import { invalidateProviderAuthCache } from './auth'
import { createSessionWithDispose } from './index'
import { promptCacheKeyForOrigin, withPromptCacheKey } from './prompt-cache-key'
import type { SessionOrigin } from './session-origin'

describe('promptCacheKeyForOrigin', () => {
  test('keys subagents and system components by name, other origins by kind', () => {
    expect(promptCacheKeyForOrigin({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'parent-a' })).toBe(
      'typeclaw:subagent:memory-logger',
    )
    expect(promptCacheKeyForOrigin({ kind: 'system', component: 'backup' })).toBe('typeclaw:system:backup')
    expect(promptCacheKeyForOrigin({ kind: 'cron', jobId: 'daily', jobKind: 'prompt' })).toBe('typeclaw:cron')
    expect(promptCacheKeyForOrigin({ kind: 'tui', sessionId: 'tui-1' })).toBe('typeclaw:tui')
    expect(promptCacheKeyForOrigin(undefined)).toBeUndefined()
  })

  test('bounds keys from long names to the 64 code points OpenAI accepts', () => {
    const key = promptCacheKeyForOrigin({ kind: 'subagent', subagent: '확'.repeat(80), parentSessionId: 'p' })

    expect(Array.from(key!)).toHaveLength(64)
    expect(key!.startsWith('typeclaw:subagent:확')).toBe(true)
  })
})

describe('withPromptCacheKey', () => {
  test('replaces an existing string key and leaves other payloads alone', () => {
    expect(withPromptCacheKey({ model: 'm', prompt_cache_key: 'session-1' }, 'k')).toEqual({
      model: 'm',
      prompt_cache_key: 'k',
    })
    const withoutKey = { model: 'm' }
    expect(withPromptCacheKey(withoutKey, 'k')).toBe(withoutKey)
    const optedOut = { model: 'm', prompt_cache_key: undefined }
    expect(withPromptCacheKey(optedOut, 'k')).toBe(optedOut)
  })
})

describe('session requests', () => {
  let agentDir: string
  const previousCwd = process.cwd()
  const previousFetch = globalThis.fetch
  const previousOpenAiKey = process.env.OPENAI_API_KEY

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-prompt-cache-key-'))
    process.chdir(agentDir)
    await writeFile(join(agentDir, 'typeclaw.json'), JSON.stringify({ models: { default: 'openai/gpt-4o-mini' } }))
    reloadConfig(agentDir)
    process.env.OPENAI_API_KEY = 'test-openai-key'
    invalidateProviderAuthCache()
  })

  afterEach(async () => {
    globalThis.fetch = previousFetch
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
    invalidateProviderAuthCache()
    __resetConfigForTesting()
    process.chdir(previousCwd)
    await rm(agentDir, { recursive: true, force: true })
  })

  async function capturePromptCacheKey(
    origin: SessionOrigin | undefined,
  ): Promise<{ key: unknown; sessionId: string }> {
    const sessionManager = SessionManager.inMemory(agentDir)
    const { session, dispose } = await createSessionWithDispose({
      sessionManager,
      systemPromptOverride: 'prompt cache key probe',
      tools: [],
      ...(origin ? { origin } : {}),
    })
    let body: Record<string, unknown> | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      body = (await new Request(input, init).json()) as Record<string, unknown>
      return new Response('{"error":{"message":"cache key probe"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      const stream = await session.agent.streamFunction(
        session.model!,
        normalizeContext({
          systemPrompt: 'probe',
          messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
          tools: [],
        }),
        { sessionId: session.sessionId },
      )
      await stream.result()
      return { key: body?.prompt_cache_key, sessionId: session.sessionId }
    } finally {
      globalThis.fetch = previousFetch
      await dispose()
    }
  }

  test('sessions of the same subagent share one prompt cache key across parents', async () => {
    // given two memory-logger sessions spawned by different parents
    const first = await capturePromptCacheKey({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'a' })
    const second = await capturePromptCacheKey({ kind: 'subagent', subagent: 'memory-logger', parentSessionId: 'b' })

    // then both requests carry the shared key instead of their own session ids
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.key).toBe('typeclaw:subagent:memory-logger')
    expect(second.key).toBe('typeclaw:subagent:memory-logger')
  })

  test('sessions without an origin keep the session-id key', async () => {
    const probe = await capturePromptCacheKey(undefined)

    expect(probe.key).toBe(probe.sessionId)
  })
})
