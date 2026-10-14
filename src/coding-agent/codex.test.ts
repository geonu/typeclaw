import { describe, expect, test } from 'bun:test'

import { codexArguments, codexConfig, codexEnvironment, CodexStreamParser } from './codex'

describe('Codex headless adapter', () => {
  test('uses only a local capability with a persistent custom Responses provider', () => {
    const config = Bun.TOML.parse(codexConfig('selected-model', 'http://127.0.0.1:12345'))
    expect(config).toMatchObject({
      model: 'selected-model',
      model_provider: 'typeclaw',
      approval_policy: 'never',
      cli_auth_credentials_store: 'ephemeral',
      model_providers: {
        typeclaw: {
          base_url: 'http://127.0.0.1:12345/v1',
          wire_api: 'responses',
          requires_openai_auth: false,
          env_key: 'TYPECLAW_CODING_AGENT_CAPABILITY',
          supports_websockets: false,
          supports_standalone_web_search: false,
          capabilities: { remote_compaction: 'unsupported' },
        },
      },
    })
    expect(codexEnvironment('/task/codex', 'invocation-capability')).toEqual({
      CODEX_HOME: '/task/codex',
      TYPECLAW_CODING_AGENT_CAPABILITY: 'invocation-capability',
    })
  })

  test('keeps the model string a TOML value rather than injected configuration', () => {
    const model = 'model"\nmodel_provider = "other'
    expect(Bun.TOML.parse(codexConfig(model, 'http://127.0.0.1:12345'))).toMatchObject({ model })
  })

  test('starts and resumes only explicit threads with stdin prompts', () => {
    const sessionId = crypto.randomUUID()
    const prefix = ['codex', 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox']
    expect(codexArguments({ sessionId, resume: false })).toEqual([...prefix, '-'])
    expect(codexArguments({ sessionId, resume: true })).toEqual([...prefix, 'resume', sessionId, '-'])
  })

  test('reads the final completed agent item and emitted thread across partial JSONL chunks', () => {
    const sessionId = crypto.randomUUID()
    const events = [
      { type: 'thread.started', thread_id: sessionId },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: '1', type: 'reasoning', text: 'not the final answer' } },
      { type: 'item.completed', item: { id: '2', type: 'agent_message', text: '진행 중' } },
      { type: 'item.updated', item: { id: '3', type: 'agent_message', text: 'not completed' } },
      { type: 'item.completed', item: { id: '3', type: 'agent_message', text: '質問があります。계속할까요?' } },
      { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } },
    ]
    const parser = new CodexStreamParser()
    const text = events.map((event) => JSON.stringify(event)).join('\n')
    for (let i = 0; i < text.length; i += 7) parser.push(text.slice(i, i + 7))
    parser.finish()
    expect(parser.sessionId).toBe(sessionId)
    expect(parser.finalMessage).toBe('質問があります。계속할까요?')
    expect(parser.terminal).toBe(true)
    expect(parser.failed).toBe(false)
    expect(parser.malformed).toBe(false)
  })

  test.each([
    ['{"type":"turn.failed","error":{"message":"failed"}}', true, true, false],
    ['{"type":"error","message":"fatal"}', true, true, false],
    ['{"type":"item.completed","item":{"id":"1","type":"error","message":"recoverable"}}', false, false, false],
    ['{"type":"item.completed","item":{"id":"1","type":"agent_message"}}', false, false, true],
    ['{"type":"thread.started","thread_id":"not-a-uuid"}', false, false, true],
    ['{"type":', false, false, true],
  ])('handles failure and incomplete events: %s', (text, terminal, failed, malformed) => {
    const parser = new CodexStreamParser()
    parser.push(text)
    parser.finish()
    expect(parser.terminal).toBe(terminal)
    expect(parser.failed).toBe(failed)
    expect(parser.malformed).toBe(malformed)
  })

  test('marks a declined command incomplete even with a completed turn', () => {
    const parser = new CodexStreamParser()
    parser.push('{"type":"item.completed","item":{"id":"1","type":"command_execution","status":"declined"}}\n')
    parser.push('{"type":"turn.completed"}\n')
    parser.finish()
    expect(parser.permissionDenied).toBe(true)
  })

  test('bounds an unfinished event instead of buffering unlimited stdout', () => {
    expect(() => new CodexStreamParser().push('x'.repeat(4 * 1024 * 1024 + 1))).toThrow()
  })
})
