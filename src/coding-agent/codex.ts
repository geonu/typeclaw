import { z } from 'zod'

export const CODEX_CLI_VERSION = '0.162.1'

export function codexArguments(options: { readonly sessionId: string; readonly resume: boolean }): string[] {
  // The runner must establish outer bwrap confinement before executing this argv.
  return [
    'codex',
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    ...(options.resume ? ['resume', options.sessionId] : []),
    '-',
  ]
}

export function codexEnvironment(configDir: string, capability: string): Record<string, string> {
  return { CODEX_HOME: configDir, TYPECLAW_CODING_AGENT_CAPABILITY: capability }
}

export function codexConfig(model: string, baseUrl: string): string {
  return `model_provider = "typeclaw"
model = ${JSON.stringify(model)}
approval_policy = "never"
check_for_update_on_startup = false
cli_auth_credentials_store = "ephemeral"

[model_providers.typeclaw]
name = "TypeClaw coding broker"
base_url = ${JSON.stringify(`${baseUrl}/v1`)}
wire_api = "responses"
requires_openai_auth = false
env_key = "TYPECLAW_CODING_AGENT_CAPABILITY"
supports_websockets = false
supports_standalone_web_search = false

[model_providers.typeclaw.capabilities]
remote_compaction = "unsupported"
`
}

const eventSchema = z.object({ type: z.string() }).passthrough()
const threadSchema = z.object({ thread_id: z.string().uuid() })
const itemSchema = z.object({
  item: z.object({ type: z.string(), text: z.string().optional(), status: z.string().optional() }),
})

export class CodexStreamParser {
  sessionId: string | undefined
  finalMessage = ''
  terminal = false
  failed = false
  permissionDenied = false
  malformed = false
  private pending = ''

  push(text: string): void {
    this.pending += text
    if (this.pending.length > 4 * 1024 * 1024) throw new Error('Codex event exceeds the 4 MiB event limit.')
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
      switch (event.type) {
        case 'thread.started':
          this.sessionId = threadSchema.parse(event).thread_id
          break
        case 'turn.started':
          this.terminal = false
          this.finalMessage = ''
          break
        case 'item.completed': {
          const { item } = itemSchema.parse(event)
          if (item.type === 'agent_message') this.finalMessage = z.string().parse(item.text)
          if (item.type === 'command_execution' && item.status === 'declined') this.permissionDenied = true
          break
        }
        case 'turn.completed':
          this.terminal = true
          break
        case 'turn.failed':
        case 'error':
          this.terminal = true
          this.failed = true
          break
      }
    } catch {
      this.malformed = true
    }
  }
}
