import { describe, expect, test } from 'bun:test'

import type { ReviewerActivity } from '@/channels/github-review-check'

import { attachReviewerActivityCapture } from './reviewer-activity'

function fakeSession() {
  const listeners: Array<(event: unknown) => void> = []
  return {
    session: {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    } as unknown as Parameters<typeof attachReviewerActivityCapture>[0],
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event)
    },
  }
}

describe('attachReviewerActivityCapture', () => {
  test('folds reviewer events into counts and categories only', () => {
    // given: a reviewer session being captured
    const { session, emit } = fakeSession()
    const reports: ReviewerActivity[] = []
    let clock = 100
    attachReviewerActivityCapture(
      session,
      (a) => reports.push(a),
      () => clock++,
    )

    // when: it reads two distinct files (one twice), searches, runs a command, then writes
    emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/secret-name.ts' } })
    emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/secret-name.ts' } })
    emit({ type: 'tool_execution_start', toolName: 'read', args: { path: 'src/b.ts' } })
    emit({ type: 'tool_execution_start', toolName: 'grep', args: { pattern: 'x' } })
    emit({ type: 'tool_execution_start', toolName: 'bash', args: { command: 'bun test' } })
    emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '<review>…' }] } })

    // then: the last report carries counts and the current category, never paths or commands
    expect(reports.at(-1)).toEqual({
      started: true,
      filesRead: 2,
      commandsRun: 1,
      current: 'writing',
      lastActivityAt: 105,
    })
    expect(JSON.stringify(reports)).not.toContain('secret-name')
    expect(JSON.stringify(reports)).not.toContain('bun test')
  })

  test('ignores user messages and unrelated events, and stops after detach', () => {
    const { session, emit } = fakeSession()
    const reports: ReviewerActivity[] = []
    const detach = attachReviewerActivityCapture(session, (a) => reports.push(a))

    emit({ type: 'message_end', message: { role: 'user', content: 'review it' } })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } })
    detach()
    emit({ type: 'tool_execution_start', toolName: 'bash', args: {} })

    expect(reports).toEqual([])
  })
})
