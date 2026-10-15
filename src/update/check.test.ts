import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareReleaseVersions,
  isCacheFresh,
  isReleaseVersion,
  parseVersionCache,
  readVersionCache,
  renderUpdateNotice,
  resolveSkipReason,
  runBackgroundCheck,
} from './check'

// NO_COLOR strips ANSI from the `c.*` helpers so the rendered notice is a plain
// assertable string across CI and local terminals.
beforeEach(() => {
  process.env.NO_COLOR = '1'
})
afterEach(() => {
  delete process.env.NO_COLOR
})

describe('isReleaseVersion', () => {
  test('accepts X.Y.Z', () => {
    expect(isReleaseVersion('0.39.2')).toBe(true)
    expect(isReleaseVersion('1.0.0')).toBe(true)
  })

  test('rejects pre-release, ranges, and dist-tags', () => {
    expect(isReleaseVersion('0.39.2-beta.1')).toBe(false)
    expect(isReleaseVersion('^0.39.2')).toBe(false)
    expect(isReleaseVersion('latest')).toBe(false)
    expect(isReleaseVersion('0.39')).toBe(false)
  })
})

describe('compareReleaseVersions', () => {
  test('orders by major, minor, patch', () => {
    expect(compareReleaseVersions('1.0.0', '0.39.2')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.40.0', '0.39.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.39.3', '0.39.2')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.39.2', '0.39.2')).toBe(0)
    expect(compareReleaseVersions('0.39.2', '0.40.0')).toBeLessThan(0)
  })

  test('compares numerically, not lexically', () => {
    expect(compareReleaseVersions('0.39.10', '0.39.9')).toBeGreaterThan(0)
    expect(compareReleaseVersions('0.100.0', '0.99.0')).toBeGreaterThan(0)
  })
})

describe('renderUpdateNotice', () => {
  test('renders a one-line notice when latest is newer', () => {
    const notice = renderUpdateNotice({
      current: '0.39.2',
      cache: { latest: '0.40.0', checkedAt: 0, lastAttemptAt: 0 },
    })
    expect(notice).toContain('0.39.2')
    expect(notice).toContain('0.40.0')
    expect(notice).toContain('typeclaw update')
    expect(notice).not.toContain('\n')
  })

  test('returns null when up to date or ahead', () => {
    expect(
      renderUpdateNotice({ current: '0.40.0', cache: { latest: '0.40.0', checkedAt: 0, lastAttemptAt: 0 } }),
    ).toBeNull()
    expect(
      renderUpdateNotice({ current: '0.41.0', cache: { latest: '0.40.0', checkedAt: 0, lastAttemptAt: 0 } }),
    ).toBeNull()
  })

  test('returns null when there is no cache', () => {
    expect(renderUpdateNotice({ current: '0.39.2', cache: null })).toBeNull()
  })

  test('returns null when the cache has only a failed attempt (no latest)', () => {
    expect(renderUpdateNotice({ current: '0.39.2', cache: { lastAttemptAt: 123 } })).toBeNull()
  })

  test('returns null when either version is not a release', () => {
    expect(
      renderUpdateNotice({ current: '0.0.0-dev', cache: { latest: '0.40.0', checkedAt: 0, lastAttemptAt: 0 } }),
    ).toBeNull()
    expect(
      renderUpdateNotice({ current: '0.39.2', cache: { latest: 'latest', checkedAt: 0, lastAttemptAt: 0 } }),
    ).toBeNull()
  })
})

describe('resolveSkipReason', () => {
  const base = {
    current: '0.39.2',
    isInstalled: true,
    configEnabled: true,
    env: {} as Record<string, string | undefined>,
  }

  test('returns null when everything is go', () => {
    expect(resolveSkipReason(base)).toBeNull()
  })

  test('skips on env opt-outs', () => {
    expect(resolveSkipReason({ ...base, env: { TYPECLAW_NO_UPDATE_CHECK: '1' } })).toBe('disabled-env')
    expect(resolveSkipReason({ ...base, env: { NO_UPDATE_NOTIFIER: 'true' } })).toBe('disabled-env')
    expect(resolveSkipReason({ ...base, env: { CI: 'true' } })).toBe('disabled-env')
  })

  test('treats falsy env strings as not-set', () => {
    expect(resolveSkipReason({ ...base, env: { CI: '' } })).toBeNull()
    expect(resolveSkipReason({ ...base, env: { CI: '0' } })).toBeNull()
    expect(resolveSkipReason({ ...base, env: { TYPECLAW_NO_UPDATE_CHECK: 'false' } })).toBeNull()
  })

  test('skips when config disabled', () => {
    expect(resolveSkipReason({ ...base, configEnabled: false })).toBe('disabled-config')
  })

  test('skips on dev checkout', () => {
    expect(resolveSkipReason({ ...base, isInstalled: false })).toBe('dev-checkout')
  })

  test('skips when current version is not a release', () => {
    expect(resolveSkipReason({ ...base, current: '0.0.0-dev' })).toBe('not-release')
  })

  test('env opt-out wins over config and dev checks', () => {
    expect(resolveSkipReason({ ...base, configEnabled: false, isInstalled: false, env: { CI: '1' } })).toBe(
      'disabled-env',
    )
  })
})

describe('isCacheFresh', () => {
  const now = 1_000_000_000_000
  const ttl = 24 * 60 * 60 * 1000

  test('fresh within the TTL, keyed on lastAttemptAt', () => {
    expect(isCacheFresh({ latest: '0.40.0', checkedAt: now, lastAttemptAt: now - 1000 }, now)).toBe(true)
    expect(isCacheFresh({ lastAttemptAt: now }, now)).toBe(true)
  })

  test('stale at or past the TTL', () => {
    expect(isCacheFresh({ lastAttemptAt: now - ttl }, now)).toBe(false)
    expect(isCacheFresh({ lastAttemptAt: now - ttl - 1 }, now)).toBe(false)
  })

  test('an old attempt is stale even when latest was fetched recently (the field that matters is lastAttemptAt)', () => {
    expect(isCacheFresh({ latest: '0.40.0', checkedAt: now, lastAttemptAt: now - ttl - 1 }, now)).toBe(false)
  })

  test('null cache is never fresh', () => {
    expect(isCacheFresh(null, now)).toBe(false)
  })

  test('a future timestamp (clock skew) is treated as stale', () => {
    expect(isCacheFresh({ lastAttemptAt: now + 1000 }, now)).toBe(false)
  })
})

describe('parseVersionCache', () => {
  test('parses a full cache with all three fields', () => {
    expect(parseVersionCache('{"latest":"0.40.0","checkedAt":123,"lastAttemptAt":456}')).toEqual({
      latest: '0.40.0',
      checkedAt: 123,
      lastAttemptAt: 456,
    })
  })

  test('parses a failure-only cache (lastAttemptAt, no latest)', () => {
    expect(parseVersionCache('{"lastAttemptAt":456}')).toEqual({ lastAttemptAt: 456 })
  })

  test('back-compat: a pre-throttle cache maps checkedAt into lastAttemptAt', () => {
    expect(parseVersionCache('{"latest":"0.40.0","checkedAt":123}')).toEqual({
      latest: '0.40.0',
      checkedAt: 123,
      lastAttemptAt: 123,
    })
  })

  test('returns null on garbage or wrong shape', () => {
    expect(parseVersionCache('not json')).toBeNull()
    expect(parseVersionCache('null')).toBeNull()
    expect(parseVersionCache('{"latest":"0.40.0"}')).toBeNull()
    expect(parseVersionCache('{"checkedAt":123}')).toBeNull()
    expect(parseVersionCache('{"latest":1,"checkedAt":123}')).toBeNull()
    expect(parseVersionCache('[]')).toBeNull()
  })
})

describe('runBackgroundCheck', () => {
  let home: string
  let prevHome: string | undefined
  const realFetch = globalThis.fetch

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'typeclaw-update-check-'))
    prevHome = process.env.TYPECLAW_HOME
    process.env.TYPECLAW_HOME = home
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.TYPECLAW_HOME
    else process.env.TYPECLAW_HOME = prevHome
    globalThis.fetch = realFetch
    await rm(home, { recursive: true, force: true })
  })

  function stubFetch(impl: () => Promise<Response> | Response): () => number {
    let calls = 0
    globalThis.fetch = (() => {
      calls++
      return impl()
    }) as unknown as typeof fetch
    return () => calls
  }

  test('a successful fetch writes latest + both timestamps', async () => {
    stubFetch(() => new Response(JSON.stringify({ version: '0.40.0' }), { status: 200 }))
    await runBackgroundCheck(1000)
    expect(await readVersionCache()).toEqual({ latest: '0.40.0', checkedAt: 1000, lastAttemptAt: 1000 })
  })

  test('a failed fetch stamps lastAttemptAt so the throttle holds (review #3)', async () => {
    stubFetch(() => new Response('nope', { status: 503 }))
    await runBackgroundCheck(2000)
    expect(await readVersionCache()).toEqual({ lastAttemptAt: 2000 })
  })

  test('a failed fetch preserves a previously-cached latest for rendering', async () => {
    stubFetch(() => new Response(JSON.stringify({ version: '0.40.0' }), { status: 200 }))
    await runBackgroundCheck(1000)

    // A day later, npm is down: latest must survive, lastAttemptAt advances.
    stubFetch(() => new Response('down', { status: 500 }))
    await runBackgroundCheck(1000 + 25 * 60 * 60 * 1000)
    expect(await readVersionCache()).toEqual({
      latest: '0.40.0',
      checkedAt: 1000,
      lastAttemptAt: 1000 + 25 * 60 * 60 * 1000,
    })
  })

  test('a fresh attempt (success or failure) short-circuits without fetching', async () => {
    const calls = stubFetch(() => new Response('down', { status: 500 }))
    await runBackgroundCheck(2000) // first run: one fetch, stamps lastAttemptAt=2000
    await runBackgroundCheck(3000) // within TTL of 2000: must NOT fetch again
    expect(calls()).toBe(1)
  })
})
