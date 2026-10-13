import type { ReviewerActivity } from '@/channels/github-review-check'

import type { AgentSession } from './index'

const READING_TOOLS = new Set(['read', 'grep', 'find', 'ls'])
const COMMAND_TOOLS = new Set(['bash'])

type SessionEvent = { type: string; toolName?: unknown; args?: unknown; message?: unknown }

// Folds a reviewer session's events into the plain categories the review check
// shows. Only counts and categories leave this function: file paths, commands,
// and model text never reach the check page.
export function attachReviewerActivityCapture(
  session: Pick<AgentSession, 'subscribe'>,
  report: (activity: ReviewerActivity) => void,
  now: () => number = Date.now,
): () => void {
  const files = new Set<string>()
  const activity: ReviewerActivity = {
    started: false,
    filesRead: 0,
    commandsRun: 0,
    current: null,
    lastActivityAt: null,
  }
  const unsubscribe = session.subscribe((raw: unknown) => {
    const event = raw as SessionEvent
    if (event.type === 'tool_execution_start' && typeof event.toolName === 'string') {
      activity.started = true
      if (READING_TOOLS.has(event.toolName)) {
        activity.current = 'reading'
        const path = (event.args as { path?: unknown } | undefined)?.path
        if (event.toolName === 'read' && typeof path === 'string') files.add(path)
        activity.filesRead = files.size
      } else if (COMMAND_TOOLS.has(event.toolName)) {
        activity.current = 'commands'
        activity.commandsRun += 1
      }
    } else if (event.type === 'message_end' && hasText(event.message)) {
      activity.current = 'writing'
    } else if (event.type !== 'tool_execution_end') {
      return
    }
    activity.lastActivityAt = now()
    report({ ...activity })
  })
  return () => {
    if (typeof unsubscribe === 'function') unsubscribe()
  }
}

function hasText(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const { role, content } = message as { role?: unknown; content?: unknown }
  if (role !== undefined && role !== 'assistant') return false
  if (typeof content === 'string') return content.trim() !== ''
  return (
    Array.isArray(content) &&
    content.some(
      (part: unknown) =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string' &&
        (part as { text: string }).text.trim() !== '',
    )
  )
}
