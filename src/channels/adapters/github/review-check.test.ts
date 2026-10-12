import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ReviewCheckKey } from '@/channels/github-review-check'

import { createGithubReviewCheckPublisher, createReviewCheckLeaseStore } from './review-check'

const KEY: ReviewCheckKey = { repo: 'acme/widgets', pullRequest: 7, headSha: 'a'.repeat(40) }

type Call = { method: string; url: string; body: Record<string, unknown> }

function fakeGithub(respond: (call: Call) => Response = () => json({ id: 555 }, 201)) {
  const calls: Call[] = []
  const fetchImpl = Object.assign(
    async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      }
      calls.push(call)
      return respond(call)
    },
    { preconnect: () => {} },
  )
  return { calls, fetchImpl }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function publisher(
  authType: 'pat' | 'app',
  fetchImpl: typeof fetch,
  options: { enabled?: boolean; warnings?: string[] } = {},
) {
  return createGithubReviewCheckPublisher({
    token: async () => 'example-token',
    authType,
    enabled: () => options.enabled ?? true,
    logger: { warn: (m) => options.warnings?.push(m) },
    fetchImpl,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
  })
}

describe('GitHub review check publisher', () => {
  test('App auth starts an in-progress check run and completes it red on requested changes', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)

    const ref = await checks.start(KEY)
    await checks.finish(KEY, ref, { kind: 'verdict', state: 'CHANGES_REQUESTED' })

    expect(ref).toEqual({ mode: 'check-run', checkRunId: 555 })
    expect(github.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.github.com/repos/acme/widgets/check-runs',
      'PATCH https://api.github.com/repos/acme/widgets/check-runs/555',
    ])
    expect(github.calls[0]?.body).toMatchObject({
      name: 'typeclaw/review',
      head_sha: KEY.headSha,
      status: 'in_progress',
    })
    expect(github.calls[1]?.body).toMatchObject({ status: 'completed', conclusion: 'failure' })
  })

  test('App auth maps approve, comment, failure, and cancellation to check run conclusions', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)
    const ref = { mode: 'check-run' as const, checkRunId: 1 }

    await checks.finish(KEY, ref, { kind: 'verdict', state: 'APPROVED' })
    await checks.finish(KEY, ref, { kind: 'verdict', state: 'COMMENTED' })
    await checks.finish(KEY, ref, { kind: 'failed', reason: 'the reviewer did not finish in time' })
    await checks.finish(KEY, ref, { kind: 'cancelled', reason: 'the review request was removed' })

    expect(github.calls.map((c) => c.body.conclusion)).toEqual(['success', 'neutral', 'failure', 'neutral'])
  })

  test('PAT auth uses commit statuses: pending, then failure on agent failure and success on cancellation', async () => {
    const github = fakeGithub(() => json({}, 201))
    const checks = publisher('pat', github.fetchImpl)

    const ref = await checks.start(KEY)
    await checks.finish(KEY, ref, { kind: 'failed', reason: 'TypeClaw restarted before this review was posted' })
    await checks.finish(KEY, ref, { kind: 'cancelled', reason: 'the review request was removed' })

    expect(ref).toEqual({ mode: 'status' })
    expect(
      github.calls.every((c) => c.url === `https://api.github.com/repos/acme/widgets/statuses/${KEY.headSha}`),
    ).toBe(true)
    expect(github.calls.map((c) => c.body.state)).toEqual(['pending', 'failure', 'success'])
    expect(github.calls[2]?.body.description).toBe('Not reviewed: the review request was removed')
    expect(github.calls.every((c) => c.body.context === 'typeclaw/review')).toBe(true)
  })

  test('a verdict without an in-progress check creates a completed one', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)

    await checks.finish(KEY, null, { kind: 'verdict', state: 'APPROVED' })
    await checks.finish(KEY, null, { kind: 'failed', reason: 'boom' })

    expect(github.calls).toHaveLength(1)
    expect(github.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.github.com/repos/acme/widgets/check-runs',
      body: { name: 'typeclaw/review', status: 'completed', conclusion: 'success' },
    })
  })

  test('a permission denial skips the check with one operator warning and stops calling GitHub', async () => {
    const warnings: string[] = []
    const github = fakeGithub(() => json({ message: 'Resource not accessible by integration' }, 403))
    const checks = publisher('app', github.fetchImpl, { warnings })

    const first = await checks.start(KEY)
    const second = await checks.start(KEY)

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(github.calls).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Checks: Read and write')
    expect(warnings[0]).toContain('channels.github.review.check')
  })

  test('a rate-limited completion is retried after the reset instead of being treated as a denial', async () => {
    // given: a started check whose completion hits a 403 secondary rate limit
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const warnings: string[] = []
    let limited = true
    const github = fakeGithub((call) => {
      if (call.method === 'PATCH' && limited) {
        return new Response(JSON.stringify({ message: 'You have exceeded a secondary rate limit' }), {
          status: 403,
          headers: { 'retry-after': '30' },
        })
      }
      return json({ id: 555 }, 201)
    })
    const checks = createGithubReviewCheckPublisher({
      token: async () => 'example-token',
      authType: 'app',
      enabled: () => true,
      logger: { warn: (m) => warnings.push(m) },
      fetchImpl: github.fetchImpl,
      now: () => clock,
    })
    const ref = await checks.start(KEY)
    const outcome = { kind: 'verdict' as const, state: 'APPROVED' as const }

    // when: completion is attempted, retried inside the window, then after it
    const first = await checks.finish(KEY, ref, outcome)
    const early = await checks.finish(KEY, ref, outcome)
    limited = false
    clock += 30_000
    const later = await checks.finish(KEY, ref, outcome)

    // then: it stays retryable, waits out the window, and finally completes the original check
    expect([first, early, later]).toEqual(['retry', 'retry', 'published'])
    expect(github.calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'PATCH'])
    expect(github.calls[2]?.url).toBe('https://api.github.com/repos/acme/widgets/check-runs/555')
    expect(warnings.some((w) => w.includes('Checks: Read and write'))).toBe(false)
  })

  test('a 429 is retried too', async () => {
    const github = fakeGithub(() => json({ message: 'Too Many Requests' }, 429))
    const checks = publisher('pat', github.fetchImpl)

    expect(await checks.finish(KEY, { mode: 'status' }, { kind: 'failed', reason: 'boom' })).toBe('retry')
  })

  test('the opt-out disables every call', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl, { enabled: false })

    expect(await checks.start(KEY)).toBeNull()
    await checks.finish(KEY, null, { kind: 'verdict', state: 'APPROVED' })

    expect(github.calls).toEqual([])
  })
})

describe('review check lease store', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  test('round-trips leases and starts empty when no file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-check-'))
    dirs.push(dir)
    const store = createReviewCheckLeaseStore(dir)

    expect(await store.load()).toEqual([])
    const lease = { ...KEY, ref: { mode: 'check-run' as const, checkRunId: 9 }, startedAt: 1 }
    await store.save([lease])

    expect(await createReviewCheckLeaseStore(dir).load()).toEqual([lease])
  })
})
