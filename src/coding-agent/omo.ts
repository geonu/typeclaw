import { join } from 'node:path'

import { z } from 'zod'

import type { CodingAgentProvider } from '@/secrets/coding-agent-auth'

import { CLAUDE_CODE_VERSION } from './claude'

export const OMO_CLI_VERSION = '5.1.19'

// Only metadata understood by the pinned Senpi transport crosses this boundary.
// Never copy provider URLs, headers, keys, or fallback chains from model records.
export const omoModelSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  reasoning: z.boolean(),
  input: z.array(z.enum(['text', 'image'])),
  contextWindow: z.number().positive(),
  maxTokens: z.number().positive(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  thinkingLevelMap: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  compat: z
    .object({
      supportsEagerToolInputStreaming: z.boolean().optional(),
      supportsLongCacheRetention: z.boolean().optional(),
      sendSessionAffinityHeaders: z.boolean().optional(),
      supportsCacheControlOnTools: z.boolean().optional(),
      supportsDisabledThinking: z.boolean().optional(),
      supportsTemperature: z.boolean().optional(),
      supportsToolChoice: z.boolean().optional(),
      supportsForcedToolChoice: z.boolean().optional(),
      forceAdaptiveThinking: z.boolean().optional(),
      allowEmptySignature: z.boolean().optional(),
      supportsToolReferences: z.boolean().optional(),
      supportsDeveloperRole: z.boolean().optional(),
    })
    .optional(),
})
export type OmoModel = z.infer<typeof omoModelSchema>

const DISABLED_COMPONENTS = [
  'memory',
  'telemetry',
  'builtin-mcps',
  'onboarding',
  'lsp',
  'ast-grep',
  'browser-bridge',
  'computer-use',
  'x-search',
  'claude-code',
  'thread',
  'gateway',
  'config-watch',
] as const

export function omoArguments(options: {
  readonly model: string
  readonly sessionId: string
  readonly configDir: string
}): string[] {
  return [
    'omo',
    '-p',
    '--mode',
    'json',
    '--model',
    `typeclaw/${options.model}`,
    '--session-dir',
    join(options.configDir, 'sessions'),
    '--session-id',
    options.sessionId,
    '--no-approve',
    '--offline',
    '--permission-preset',
    'full-access',
    '--no-ask-user',
    '--no-model-fallback',
    '--no-recommended-models',
    ...DISABLED_COMPONENTS.map((name) => `--omo-senpi-${name}-disabled`),
  ]
}

export function omoEnvironment(configDir: string, capability: string): Record<string, string> {
  return {
    HOME: join(configDir, 'home'),
    OMO_CODING_AGENT_DIR: join(configDir, 'agent'),
    TMPDIR: join(configDir, 'tmp'),
    BUN_TMPDIR: join(configDir, 'tmp'),
    BUN_INSTALL: join(configDir, 'home', '.bun'),
    XDG_CONFIG_HOME: join(configDir, 'config'),
    XDG_CACHE_HOME: join(configDir, 'cache'),
    XDG_DATA_HOME: join(configDir, 'data'),
    XDG_STATE_HOME: join(configDir, 'state'),
    TYPECLAW_CODING_AGENT_CAPABILITY: capability,
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    OMO_SEND_ANONYMOUS_TELEMETRY: '0',
    SENPI_NO_FALLBACK: '1',
    PI_CLAUDE_CODE_VERSION: CLAUDE_CODE_VERSION,
  }
}

export function omoConfiguration(options: {
  readonly configDir: string
  readonly baseUrl: string
  readonly provider: CodingAgentProvider
  readonly model: OmoModel
}) {
  const model = `typeclaw/${options.model.id}`
  return {
    models: {
      providers: {
        typeclaw: {
          baseUrl: options.baseUrl + (options.provider === 'openai-codex' ? '/v1' : ''),
          api: options.provider === 'anthropic' ? 'anthropic-messages' : 'openai-codex-responses',
          apiKey: '$TYPECLAW_CODING_AGENT_CAPABILITY',
          authHeader: true,
          models: [options.model],
        },
      },
    },
    settings: {
      enableInstallTelemetry: false,
      transport: 'sse',
      permissionPreset: 'full-access',
      retry: { modelFallback: false },
      compaction: { model },
      enabledModels: [model],
      disabledBuiltinExtensions: [
        'mcp',
        'cache-keepalive',
        'claude-sdk-oauth',
        'cursor-cli-oauth',
        'imagegen',
        'openai-image-gen',
        'anthropic-web-search',
        'openai-web-search',
        'look-at',
        'video-in',
        'btw',
        'schedule',
      ],
    },
    orchestration: {
      model_profile: model,
      memory: { enabled: false },
      telemetry: { enabled: false },
      task: {
        state_dir: join(options.configDir, 'task-state'),
        default_execution_mode: 'in-process',
        host_shard_prewarm: 'off',
        default_concurrency: 3,
        global_concurrency: 3,
        max_depth: 1,
        isolation: { enabled: false },
      },
      categories: Object.fromEntries(
        [
          'visual-engineering',
          'artistry',
          'ultrabrain',
          'deep-low',
          'deep-high',
          'quick',
          'unspecified-low',
          'unspecified-high',
          'architect',
          'writing',
        ].map((name) => [name, { models: [model] }]),
      ),
      agents: Object.fromEntries(
        [
          'explore',
          'librarian',
          'plan-consultant',
          'plan-reviewer',
          'omo-native-code-reviewer',
          'omo-native-qa-executor',
          'omo-native-gate-reviewer',
        ].map((name) => [name, { model, models: [], execution_mode: 'in-process' }]),
      ),
    },
  }
}
