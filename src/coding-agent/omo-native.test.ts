import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveModel } from '@/config'
import { DEFAULT_SANDBOX_ENV } from '@/sandbox/policy'

import { startCodingBroker } from './broker'
import { omoModelSchema } from './omo'
import { runCodingAgent, type CodingRunOptions } from './runner'

// Opt-in, credential-free native protocol qualification. This is deliberately
// NOT Linux/bwrap or live subscription acceptance. Never resolve real auth.
const executable = process.env.TYPECLAW_TEST_OMO_BIN

function sse(events: readonly { type: string; [key: string]: unknown }[]) {
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test.skipIf(!executable || process.platform === 'win32')(
  'pinned native OmO runs a category child through the broker and resumes exactly',
  async () => {
    if (!executable) throw new Error('Native executable required')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'omo-native-')))
    for (const name of ['worktree', 'output']) await mkdir(join(root, name))
    const requests: Array<{
      model: string
      messages: unknown[]
      system?: Array<{ text?: string }>
      tools?: Array<{ name: string }>
    }> = []
    let step = 0
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        expect(request.headers.get('authorization')).toBe('Bearer native-upstream-canary')
        expect(request.headers.get('user-agent')).toBe('claude-cli/2.1.299')
        expect(request.headers.get('anthropic-beta')).toContain('oauth-2025-04-20')
        const body = await request.json()
        requests.push(body)
        const current = step++
        const task =
          current === 0
            ? body.tools?.find((tool: { name: string }) => tool.name.toLowerCase() === 'task')?.name
            : undefined
        if (current === 0 && !task) throw new Error('Native task tool missing')
        const text = current === 1 ? '자식 완료' : '작업 완료'
        return sse([
          {
            type: 'message_start',
            message: {
              id: 'msg_fixture',
              type: 'message',
              role: 'assistant',
              content: [],
              model: body.model,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 2, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: task
              ? { type: 'tool_use', id: 'call_fixture', name: task, input: {} }
              : { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: task
              ? {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify({
                    category: 'quick',
                    prompt: 'Reply in Korean.',
                    description: 'Broker child',
                    task_summary: 'Verify brokered child inference',
                    run_in_background: false,
                  }),
                }
              : { type: 'text_delta', text },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: task ? 'tool_use' : 'end_turn', stop_sequence: null },
            usage: { output_tokens: 2 },
          },
          { type: 'message_stop' },
        ])
      },
    })
    const options: CodingRunOptions = {
      engine: 'omo',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      modelMetadata: omoModelSchema.parse(resolveModel('anthropic/claude-sonnet-4-6')),
      allowedModels: ['claude-sonnet-4-6'],
      mode: 'code',
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt: 'Use one quick child, then answer in Korean.',
      timeoutSeconds: 60,
      workspace: { source: root, taskRoot: root, baseSha: 'a'.repeat(40), sourceIdentity: 'fixture' },
      auth: {
        resolve: async () => ({
          provider: 'anthropic',
          type: 'oauth',
          token: 'native-upstream-canary',
          secrets: ['native-upstream-canary'],
        }),
      },
      writeArtifact: (path, text) => writeFile(path, text),
    }
    const dependencies = {
      command: async (argv: readonly string[], env: Record<string, string>) => ({
        argv: [executable, ...argv.slice(1), '--tools', 'task'],
        env: { ...DEFAULT_SANDBOX_ENV, ...env },
      }),
      broker: (opts: Parameters<typeof startCodingBroker>[0]) =>
        startCodingBroker(opts, { upstream: new URL(server.url) }),
    }
    try {
      const first = await runCodingAgent(options, dependencies)
      expect(first).toMatchObject({ state: 'completed', finalMessage: '작업 완료', sessionId: options.sessionId })
      expect(requests).toHaveLength(3)
      expect(requests.every((request) => request.model === options.model)).toBe(true)
      const second = await runCodingAgent({ ...options, resume: true, prompt: '계속해 주세요' }, dependencies)
      expect(second).toMatchObject({ state: 'completed', sessionId: options.sessionId, finalMessage: '작업 완료' })
      expect(requests.at(-1)?.messages.length).toBeGreaterThan(requests[0]?.messages.length ?? 0)
      for (const file of await Array.fromAsync(
        new Bun.Glob('{omo,output}/**/*').scan({ cwd: root, onlyFiles: true, dot: true }),
      )) {
        // Native runtime binaries are large; generated text state is sufficient
        // here. Linux process/file confidentiality is a separate release gate.
        if (!/\.(json|jsonc|jsonl|stderr)$/.test(file)) continue
        expect(await readFile(join(root, file), 'utf8')).not.toContain('native-upstream-canary')
      }
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)

test.skipIf(!executable || process.platform === 'win32')(
  'pinned native OmO Codex uses opaque capability and the compressed Responses route',
  async () => {
    if (!executable) throw new Error('Native executable required')
    const root = await realpath(await mkdtemp(join(tmpdir(), 'omo-native-codex-')))
    for (const name of ['worktree', 'output']) await mkdir(join(root, name))
    const inputs: unknown[][] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (request) => {
        expect(new URL(request.url).pathname).toBe('/backend-api/codex/responses')
        expect(request.headers.get('authorization')).toBe('Bearer native-codex-canary')
        expect(request.headers.get('chatgpt-account-id')).toBe('trusted-account')
        expect(request.headers.get('content-encoding')).toBeNull()
        const body = await request.json()
        expect(body).toMatchObject({ model: 'gpt-6-sol', stream: true, store: false })
        inputs.push(body.input)
        const item = { id: 'item_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] }
        return sse([
          { type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          {
            type: 'response.content_part.added',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
          {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: '応答しました',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              ...item,
              status: 'completed',
              content: [{ type: 'output_text', text: '応答しました', annotations: [] }],
            },
          },
          {
            type: 'response.completed',
            response: {
              id: 'resp_fixture',
              status: 'completed',
              output: [],
              usage: {
                input_tokens: 2,
                output_tokens: 2,
                total_tokens: 4,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          },
        ])
      },
    })
    const options: CodingRunOptions = {
      engine: 'omo',
      provider: 'openai-codex',
      model: 'gpt-6-sol',
      modelMetadata: omoModelSchema.parse(resolveModel('openai-codex/gpt-6-sol')),
      allowedModels: ['gpt-6-sol'],
      mode: 'code',
      sessionId: crypto.randomUUID(),
      resume: false,
      prompt: 'Reply in Japanese.',
      timeoutSeconds: 60,
      workspace: { source: root, taskRoot: root, baseSha: 'a'.repeat(40), sourceIdentity: 'fixture' },
      auth: {
        resolve: async () => ({
          provider: 'openai-codex',
          type: 'oauth',
          token: 'native-codex-canary',
          accountId: 'trusted-account',
          secrets: ['native-codex-canary'],
        }),
      },
      writeArtifact: (path, text) => writeFile(path, text),
    }
    const dependencies = {
      command: async (argv: readonly string[], env: Record<string, string>) => ({
        argv: [executable, ...argv.slice(1), '--no-tools'],
        env: { ...DEFAULT_SANDBOX_ENV, ...env },
      }),
      broker: (opts: Parameters<typeof startCodingBroker>[0]) =>
        startCodingBroker(opts, { upstream: new URL(server.url) }),
    }
    try {
      expect(await runCodingAgent(options, dependencies)).toMatchObject({
        state: 'completed',
        finalMessage: '応答しました',
      })
      expect(await runCodingAgent({ ...options, resume: true, prompt: '続けてください' }, dependencies)).toMatchObject({
        state: 'completed',
        sessionId: options.sessionId,
      })
      expect(inputs).toHaveLength(2)
      expect(inputs[1]?.length).toBeGreaterThan(inputs[0]?.length ?? 0)
      for (const file of await Array.fromAsync(
        new Bun.Glob('{omo,output}/**/*.{json,jsonc,jsonl,stderr}').scan({ cwd: root, onlyFiles: true, dot: true }),
      )) {
        const text = await readFile(join(root, file), 'utf8')
        expect(text).not.toContain('native-codex-canary')
        expect(text).not.toContain('trusted-account')
      }
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000,
)
