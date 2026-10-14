import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { resolveModel } from '@/config'

import { omoArguments, omoConfiguration, omoEnvironment, omoModelSchema } from './omo'
import { OmoStreamParser } from './omo-stream'

const sessionId = '0199abcd-1234-7123-8123-123456789abc'
const cwd = '/task/worktree'
const header = { type: 'session', version: 3, id: sessionId, cwd }
const assistant = (stopReason = 'stop', text = '質問があります。계속할까요?') => ({
  role: 'assistant',
  stopReason,
  content: [
    { type: 'thinking', thinking: 'hidden' },
    { type: 'text', text },
  ],
})
function parse(events: readonly unknown[]) {
  const parser = new OmoStreamParser({ sessionId, cwd })
  const text = events.map((event) => JSON.stringify(event)).join('\n') + '\n'
  for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7))
  parser.finish()
  return parser
}

describe('OmO adapter configuration', () => {
  test.each(['anthropic/claude-sonnet-4-6', 'openai-codex/gpt-6-sol'])('pins every inference lane for %s', (ref) => {
    const resolved = resolveModel(ref)
    const model = omoModelSchema.parse({
      ...resolved,
      headers: { authorization: 'must-not-copy' },
      compat: { ...resolved.compat, allowedFallbackModels: [{ provider: 'other', model: 'other' }] },
    })
    const provider = ref.startsWith('anthropic/') ? 'anthropic' : 'openai-codex'
    const config = omoConfiguration({ configDir: '/task/omo', baseUrl: 'http://127.0.0.1:12345', provider, model })
    const selected = `typeclaw/${resolved.id}`
    expect(config.models.providers.typeclaw).toMatchObject({
      baseUrl: `http://127.0.0.1:12345${provider === 'anthropic' ? '' : '/v1'}`,
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses',
      apiKey: '$TYPECLAW_CODING_AGENT_CAPABILITY',
      authHeader: true,
      models: [
        { id: resolved.id, contextWindow: resolved.contextWindow, maxTokens: resolved.maxTokens, cost: resolved.cost },
      ],
    })
    expect(config.settings.enabledModels).toEqual([selected])
    expect(config.settings.compaction.model).toBe(selected)
    expect(config.settings.transport).toBe('sse')
    expect(config.settings.retry.modelFallback).toBe(false)
    expect(config.settings.disabledBuiltinExtensions).toEqual(
      expect.arrayContaining(['mcp', 'claude-sdk-oauth', 'cursor-cli-oauth']),
    )
    expect(Object.keys(config.orchestration.categories)).toHaveLength(10)
    for (const category of Object.values(config.orchestration.categories)) expect(category.models).toEqual([selected])
    expect(Object.keys(config.orchestration.agents)).toHaveLength(7)
    for (const agent of Object.values(config.orchestration.agents))
      expect(agent).toEqual({ model: selected, models: [], execution_mode: 'in-process' })
    expect(config.orchestration.task).toMatchObject({
      global_concurrency: 3,
      max_depth: 1,
      isolation: { enabled: false },
      host_shard_prewarm: 'off',
    })
    expect(config.orchestration.memory.enabled).toBe(false)
    expect(config.orchestration.telemetry.enabled).toBe(false)
    expect(JSON.stringify(config)).not.toContain('must-not-copy')
    expect(JSON.stringify(config)).not.toContain('allowedFallbackModels')
    if (provider === 'anthropic') expect(model.compat?.forceAdaptiveThinking).toBe(true)
  })

  test('uses exact sessions and task-local non-secret environment without disabling orchestration', () => {
    const args = omoArguments({ model: 'selected', sessionId, configDir: '/task/omo' })
    expect(args.slice(0, 6)).toEqual(['omo', '-p', '--mode', 'json', '--model', 'typeclaw/selected'])
    expect(args.slice(6, 10)).toEqual(['--session-dir', join('/task/omo', 'sessions'), '--session-id', sessionId])
    expect(args).toEqual(
      expect.arrayContaining([
        '--no-approve',
        '--offline',
        '--permission-preset',
        'full-access',
        '--no-model-fallback',
        '--omo-senpi-memory-disabled',
        '--omo-senpi-telemetry-disabled',
      ]),
    )
    expect(args).not.toContain('--no-extensions')
    expect(args).not.toContain('--omo-senpi-task-disabled')
    const env = omoEnvironment('/task/omo', 'local-capability')
    expect(env.TYPECLAW_CODING_AGENT_CAPABILITY).toBe('local-capability')
    for (const key of [
      'HOME',
      'OMO_CODING_AGENT_DIR',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ])
      expect(env[key]?.startsWith(join('/task/omo'))).toBe(true)
    expect(env).toMatchObject({
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      SENPI_NO_FALLBACK: '1',
      PI_CLAUDE_CODE_VERSION: '2.1.299',
    })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })
})

describe('OmO structured completion', () => {
  test('returns only the last assistant text after tool recovery and subsequent runs', () => {
    const parser = parse([
      header,
      { type: 'agent_start' },
      { type: 'message_end', message: assistant('toolUse', 'intermediate') },
      { type: 'tool_execution_end', toolCallId: 'call', toolName: 'bash', isError: true, result: { content: [] } },
      { type: 'future_event', value: 1 },
      { type: 'agent_end', messages: [assistant('error')], willRetry: true },
      { type: 'agent_start' },
      {
        type: 'agent_end',
        messages: [{ role: 'user', content: 'hidden' }, assistant('stop', 'earlier'), { role: 'custom' }, assistant()],
      },
    ])
    expect(parser).toMatchObject({
      sessionId,
      terminal: true,
      failed: false,
      malformed: false,
      finalMessage: '質問があります。계속할까요?',
    })
  })

  test.each([
    ['stop', true, false],
    ['length', false, false],
    ['toolUse', false, false],
    ['error', true, true],
    ['aborted', true, true],
  ] as const)('classifies %s independently of exit status or prose', (reason, terminal, failed) => {
    expect(parse([header, { type: 'agent_end', messages: [assistant(reason)] }])).toMatchObject({
      terminal,
      failed,
      malformed: false,
    })
  })

  test.each([
    [{ ...header, id: crypto.randomUUID() }],
    [{ ...header, version: 2 }],
    [header, header],
    [header, { type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'unknown' } }],
    [header, { type: 'agent_end', messages: 'invalid' }],
    [header, { type: 'agent_end', messages: [assistant()], willRetry: 'false' }],
    [header, { type: 'tool_execution_end', isError: 'false' }],
  ])('rejects invalid known payloads: %j', (...events) => {
    expect(parse(events).malformed).toBe(true)
  })

  test('clears settled state when a later run starts or retries', () => {
    for (const last of [{ type: 'agent_start' }, { type: 'agent_end', messages: [assistant()], willRetry: true }]) {
      expect(parse([header, { type: 'agent_end', messages: [assistant()] }, last])).toMatchObject({
        terminal: false,
        finalMessage: '',
      })
    }
    expect(parse([header, { type: 'agent_end', messages: [{ role: 'custom' }] }]).terminal).toBe(false)
    expect(parse([{ type: 'agent_end', messages: [assistant()] }]).sessionId).toBeUndefined()
  })

  test('rejects truncated framing, invalid JSON, and oversized snapshots', () => {
    const parser = new OmoStreamParser({ sessionId, cwd })
    parser.push(JSON.stringify(header))
    parser.finish()
    expect(parser.malformed).toBe(true)
    expect(parse(['not an object']).malformed).toBe(true)
    expect(() => new OmoStreamParser({ sessionId, cwd }).push('x'.repeat(4 * 1024 * 1024 + 1))).toThrow()
    expect(() => new OmoStreamParser({ sessionId, cwd }).push('x'.repeat(4 * 1024 * 1024 + 1) + '\n')).toThrow()
  })
})
