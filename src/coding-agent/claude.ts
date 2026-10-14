import { z } from 'zod'

export const CLAUDE_CODE_VERSION = '2.1.299'
// Explicit compatibility set, not an open-ended provider allowlist.
export const CLAUDE_AUXILIARY_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'] as const
export type CodingMode = 'code' | 'plan'

export function claudeArguments(options: {
  model: string
  mode: CodingMode
  sessionId: string
  resume: boolean
}): string[] {
  return [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    options.model,
    '--permission-mode',
    options.mode === 'plan' ? 'plan' : 'dontAsk',
    '--allowedTools',
    'Read,Edit,Write,Bash,Agent,Glob,Grep',
    '--settings',
    JSON.stringify({ sandbox: { enabled: false } }),
    options.resume ? '--resume' : '--session-id',
    options.sessionId,
  ]
}

export function claudeEnvironment(configDir: string, baseUrl: string, capability: string): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: capability,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: CLAUDE_AUXILIARY_MODELS[0],
    ANTHROPIC_DEFAULT_SONNET_MODEL: CLAUDE_AUXILIARY_MODELS[1],
    ANTHROPIC_DEFAULT_OPUS_MODEL: CLAUDE_AUXILIARY_MODELS[2],
  }
}

const eventSchema = z
  .object({
    type: z.string(),
    session_id: z.string().uuid().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    permission_denials: z.array(z.unknown()).optional(),
  })
  .passthrough()

export class ClaudeStreamParser {
  sessionId: string | undefined
  finalMessage = ''
  terminal = false
  failed = false
  permissionDenied = false
  malformed = false
  private pending = ''

  push(text: string): void {
    this.pending += text
    if (this.pending.length > 4 * 1024 * 1024) throw new Error('Claude event exceeds the 4 MiB event limit.')
    let newline: number
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.line(line)
    }
  }

  finish(): void {
    if (this.pending.trim()) this.line(this.pending)
    this.pending = ''
  }

  private line(line: string): void {
    if (!line.trim()) return
    try {
      const event = eventSchema.parse(JSON.parse(line))
      if (event.session_id) this.sessionId = event.session_id
      if (event.type !== 'result') return
      this.terminal = true
      this.failed = event.is_error === true || event.subtype !== 'success'
      this.permissionDenied = (event.permission_denials?.length ?? 0) > 0
      this.finalMessage = event.result ?? ''
    } catch {
      this.malformed = true
    }
  }
}
