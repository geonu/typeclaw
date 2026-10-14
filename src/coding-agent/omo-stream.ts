import { z } from 'zod'

const eventSchema = z.object({ type: z.string().min(1) }).passthrough()
const messageSchema = z.object({ role: z.string() }).passthrough()
const assistantSchema = z.object({
  role: z.literal('assistant'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  stopReason: z.enum(['stop', 'length', 'toolUse', 'error', 'aborted']),
})
const sessionSchema = z.object({
  type: z.literal('session'),
  version: z.literal(3),
  id: z.string().uuid(),
  cwd: z.string(),
})

export class OmoStreamParser {
  sessionId: string | undefined
  finalMessage = ''
  terminal = false
  failed = false
  permissionDenied = false
  malformed = false
  private pending = ''

  constructor(private readonly expected: { readonly sessionId: string; readonly cwd: string }) {}

  push(text: string): void {
    this.pending += text
    let newline: number
    while ((newline = this.pending.indexOf('\n')) !== -1) {
      if (newline > 4 * 1024 * 1024) throw new Error('OmO event exceeds the 4 MiB event limit.')
      const line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      this.line(line)
    }
    if (this.pending.length > 4 * 1024 * 1024) throw new Error('OmO event exceeds the 4 MiB event limit.')
  }

  finish(): void {
    // The pinned print-mode protocol always flushes newline-delimited records.
    if (this.pending.trim()) this.malformed = true
    this.pending = ''
  }

  private line(line: string): void {
    if (!line.trim()) return
    try {
      const event = eventSchema.parse(JSON.parse(line))
      switch (event.type) {
        case 'session': {
          const session = sessionSchema.parse(event)
          if (session.id !== this.expected.sessionId || session.cwd !== this.expected.cwd || this.sessionId) {
            this.malformed = true
          } else this.sessionId = session.id
          break
        }
        case 'agent_start':
          this.terminal = false
          this.failed = false
          this.finalMessage = ''
          break
        case 'message_end': {
          const { message } = z.object({ message: messageSchema }).parse(event)
          if (message.role === 'assistant') assistantSchema.parse(message)
          break
        }
        case 'tool_execution_end':
          // Failed tools may be recovered by the agent. Keep their structured
          // events in the JSONL artifact, not as a terminal English heuristic.
          z.object({ toolCallId: z.string(), toolName: z.string(), isError: z.boolean(), result: z.unknown() }).parse(
            event,
          )
          break
        case 'agent_end': {
          const end = z.object({ messages: z.array(messageSchema), willRetry: z.boolean().optional() }).parse(event)
          const assistants = end.messages
            .filter((message) => message.role === 'assistant')
            .map((message) => assistantSchema.parse(message))
          const final = assistants.at(-1)
          this.terminal = false
          this.failed = false
          this.finalMessage = ''
          if (end.willRetry || !final) break
          this.finalMessage = final.content
            .filter((block) => block.type === 'text')
            .map((block) => z.string().parse(block.text))
            .join('\n')
          this.failed = final.stopReason === 'error' || final.stopReason === 'aborted'
          this.terminal = final.stopReason === 'stop' || this.failed
          break
        }
      }
    } catch {
      this.malformed = true
    }
  }
}
