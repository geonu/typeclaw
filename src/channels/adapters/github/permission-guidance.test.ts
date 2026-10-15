import { describe, expect, test } from 'bun:test'

import { isOutboundPermissionDenial, parseListHooksPermissionStatus } from './permission-guidance'

describe('parseListHooksPermissionStatus', () => {
  test('returns 404 for a 404 list-hooks error', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 404 {"message":"Not Found"}')).toBe(404)
  })

  test('returns 403 for a 403 list-hooks error', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 403 {"message":"Forbidden"}')).toBe(403)
  })

  test('returns null for a 500 list-hooks error (not a permission issue)', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 500 server error')).toBeNull()
  })

  test('returns null for a 401 list-hooks error (auth-config issue, not repo permission)', () => {
    expect(parseListHooksPermissionStatus('list hooks failed: 401 bad creds')).toBeNull()
  })

  test('returns null for a create-hook 403 (different code path, different remediation)', () => {
    expect(parseListHooksPermissionStatus('create hook failed: 403 forbidden')).toBeNull()
  })

  test('returns null for an invalid-slug error', () => {
    expect(parseListHooksPermissionStatus('invalid repo slug: "weird" (expected owner/name)')).toBeNull()
  })

  test('returns null for a network error', () => {
    expect(parseListHooksPermissionStatus('fetch failed: ECONNREFUSED')).toBeNull()
  })
})

describe('isOutboundPermissionDenial', () => {
  test('matches the exact GitHub body for a permission-denied integration', () => {
    expect(isOutboundPermissionDenial(403, '{"message":"Resource not accessible by integration"}')).toBe(true)
  })

  test('does not match other 403 bodies (e.g. org SSO)', () => {
    expect(isOutboundPermissionDenial(403, '{"message":"Resource protected by organization SAML enforcement."}')).toBe(
      false,
    )
  })

  test('does not match a permission-denial string on a non-403 status', () => {
    expect(isOutboundPermissionDenial(401, 'Resource not accessible by integration')).toBe(false)
    expect(isOutboundPermissionDenial(404, 'Resource not accessible by integration')).toBe(false)
  })

  test('matches when the denial string is embedded in a longer body', () => {
    expect(
      isOutboundPermissionDenial(403, '{"foo":1,"message":"Resource not accessible by integration","bar":2}'),
    ).toBe(true)
  })
})
