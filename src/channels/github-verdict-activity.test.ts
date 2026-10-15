import { describe, expect, test } from 'bun:test'

import { parsePrVerdictActivityPayload } from './github-verdict-activity'

describe('parsePrVerdictActivityPayload', () => {
  test('parses a well-formed landed payload', () => {
    const parsed = parsePrVerdictActivityPayload({
      kind: 'pr.verdict-activity',
      workspace: 'acme/widgets',
      prNumber: 42,
      verdict: 'APPROVE',
      sessionId: 'ses_abc',
    })
    expect(parsed).toEqual({ workspace: 'acme/widgets', prNumber: 42, verdict: 'APPROVE', sessionId: 'ses_abc' })
  })

  test('rejects a payload whose kind is not pr.verdict-activity', () => {
    expect(parsePrVerdictActivityPayload({ kind: 'subagent.completed', workspace: 'a/b', prNumber: 1 })).toBeNull()
  })

  test('rejects a non-object payload', () => {
    expect(parsePrVerdictActivityPayload(null)).toBeNull()
    expect(parsePrVerdictActivityPayload('pr.verdict-activity')).toBeNull()
  })

  test('rejects a payload missing the routing key (workspace / prNumber)', () => {
    expect(
      parsePrVerdictActivityPayload({ kind: 'pr.verdict-activity', verdict: 'APPROVE', sessionId: 'ses_abc' }),
    ).toBeNull()
    expect(
      parsePrVerdictActivityPayload({
        kind: 'pr.verdict-activity',
        workspace: 'acme/widgets',
        verdict: 'APPROVE',
        sessionId: 'ses_abc',
      }),
    ).toBeNull()
  })

  test('rejects a non-verdict review state (only APPROVE / REQUEST_CHANGES carry duplicate risk)', () => {
    expect(
      parsePrVerdictActivityPayload({
        kind: 'pr.verdict-activity',
        workspace: 'acme/widgets',
        prNumber: 42,
        verdict: 'COMMENT',
        sessionId: 'ses_abc',
      }),
    ).toBeNull()
  })

  test('rejects a non-integer prNumber', () => {
    expect(
      parsePrVerdictActivityPayload({
        kind: 'pr.verdict-activity',
        workspace: 'acme/widgets',
        prNumber: 4.2,
        verdict: 'APPROVE',
        sessionId: 'ses_abc',
      }),
    ).toBeNull()
  })

  test('parses a REQUEST_CHANGES verdict', () => {
    const parsed = parsePrVerdictActivityPayload({
      kind: 'pr.verdict-activity',
      workspace: 'acme/widgets',
      prNumber: 7,
      verdict: 'REQUEST_CHANGES',
      sessionId: 'ses_xyz',
    })
    expect(parsed?.verdict).toBe('REQUEST_CHANGES')
  })
})
