import { describe, expect, test } from 'bun:test'

import { decodeJwtExpMs, isTokenNearExpiry, LINE_TOKEN_REFRESH_SKEW_MS, nextRefreshDelayMs } from './line-token'

function jwt(payload: Record<string, unknown>): string {
  const b64 = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64({ typ: 'JWT', alg: 'HS256' })}.${b64(payload)}.sig`
}

describe('decodeJwtExpMs', () => {
  test('returns exp in milliseconds', () => {
    expect(decodeJwtExpMs(jwt({ exp: 1_781_785_105 }))).toBe(1_781_785_105_000)
  })

  test('returns null for a non-JWT string', () => {
    expect(decodeJwtExpMs('not-a-jwt')).toBeNull()
  })

  test('returns null when exp is missing or non-numeric', () => {
    expect(decodeJwtExpMs(jwt({ aud: 'LINE' }))).toBeNull()
    expect(decodeJwtExpMs(jwt({ exp: 'soon' }))).toBeNull()
  })

  test('returns null for malformed base64 payload', () => {
    expect(decodeJwtExpMs('a.@@@.c')).toBeNull()
  })
})

describe('isTokenNearExpiry', () => {
  const exp = 1_781_785_105_000

  test('false when well outside the skew window', () => {
    expect(isTokenNearExpiry(jwt({ exp: exp / 1000 }), exp - 2 * LINE_TOKEN_REFRESH_SKEW_MS)).toBe(false)
  })

  test('true once inside the skew window', () => {
    expect(isTokenNearExpiry(jwt({ exp: exp / 1000 }), exp - LINE_TOKEN_REFRESH_SKEW_MS + 1)).toBe(true)
  })

  test('true for an already-expired token', () => {
    expect(isTokenNearExpiry(jwt({ exp: exp / 1000 }), exp + 1)).toBe(true)
  })

  test('treats an undecodable token as needing refresh', () => {
    expect(isTokenNearExpiry('garbage', Date.now())).toBe(true)
  })
})

describe('nextRefreshDelayMs', () => {
  const exp = 1_781_785_105_000

  test('schedules toward the refresh window, capped at the daily re-check', () => {
    // Window opens in 4 days, but the timer wakes at most daily to re-evaluate
    // (it reschedules each tick), so the delay clamps to the 24h maximum.
    const now = exp - 5 * LINE_TOKEN_REFRESH_SKEW_MS
    expect(nextRefreshDelayMs(jwt({ exp: exp / 1000 }), now)).toBe(24 * 60 * 60 * 1000)
  })

  test('schedules to the exact window start when it is under the daily cap', () => {
    const now = exp - LINE_TOKEN_REFRESH_SKEW_MS - 60 * 60 * 1000
    expect(nextRefreshDelayMs(jwt({ exp: exp / 1000 }), now)).toBe(60 * 60 * 1000)
  })

  test('clamps to a minimum delay when already inside the window', () => {
    expect(nextRefreshDelayMs(jwt({ exp: exp / 1000 }), exp)).toBe(60_000)
  })

  test('falls back to the minimum delay for an undecodable token', () => {
    expect(nextRefreshDelayMs('garbage', Date.now())).toBe(60_000)
  })
})
