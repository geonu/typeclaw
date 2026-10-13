import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GithubReviewCheckTracker, type ReviewCheckKey } from '@/channels/github-review-check'

import {
  createGithubReviewCheckPublisher,
  createReviewCheckLeaseStore,
  REVIEW_CHECK_MAX_FINDINGS,
  reviewCheckDetails,
  reviewCheckName,
} from './review-check'

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
  options: { enabled?: boolean; warnings?: string[]; checkName?: () => string } = {},
) {
  return createGithubReviewCheckPublisher({
    token: async () => 'example-token',
    authType,
    enabled: () => options.enabled ?? true,
    checkName: options.checkName ?? (() => 'my-agent'),
    logger: { warn: (m) => options.warnings?.push(m) },
    fetchImpl,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
  })
}

describe('reviewCheckName', () => {
  test('names the check after the agent login, dropping the App [bot] suffix', () => {
    expect(reviewCheckName('my-agent[bot]')).toBe('my-agent')
    expect(reviewCheckName('octo-reviewer')).toBe('octo-reviewer')
    expect(reviewCheckName(null)).toBe('typeclaw/review')
  })
})

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
      name: 'my-agent',
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

    expect(ref).toEqual({ mode: 'status', context: 'my-agent' })
    expect(
      github.calls.every((c) => c.url === `https://api.github.com/repos/acme/widgets/statuses/${KEY.headSha}`),
    ).toBe(true)
    expect(github.calls.map((c) => c.body.state)).toEqual(['pending', 'failure', 'success'])
    expect(github.calls[2]?.body.description).toBe('Not reviewed: the review request was removed')
    expect(github.calls.every((c) => c.body.context === 'my-agent')).toBe(true)
  })

  test('a PAT status finishes under the name it started with, even if the agent name changed', async () => {
    // given: a status started as one name, and a lease persisted before per-agent names
    const github = fakeGithub(() => json({}, 201))
    let name = 'old-agent'
    const checks = publisher('pat', github.fetchImpl, { checkName: () => name })
    const ref = await checks.start(KEY)
    name = 'new-agent'

    // when: both are finished
    await checks.finish(KEY, ref, { kind: 'verdict', state: 'APPROVED' })
    await checks.finish(KEY, { mode: 'status' }, { kind: 'verdict', state: 'APPROVED' })

    // then: each completion replaces its own pending status
    expect(github.calls.map((c) => c.body.context)).toEqual(['old-agent', 'old-agent', 'typeclaw/review'])
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
      body: { name: 'my-agent', status: 'completed', conclusion: 'success' },
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
      checkName: () => 'my-agent',
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

  test('progress updates the running check with plain-language steps and no internal identifiers', async () => {
    // given: a running check whose reviewer has read code and is running commands
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)
    const t0 = Date.parse('2026-01-01T00:00:00Z')

    // when: progress is published 4m12s in
    await checks.progress?.(
      KEY,
      { mode: 'check-run', checkRunId: 555 },
      {
        phase: 'reviewing',
        startedAt: t0,
        now: t0 + 252_000,
        reviewKind: 're-review',
        activity: { started: true, filesRead: 14, commandsRun: 2, current: 'commands', lastActivityAt: t0 + 246_000 },
      },
    )

    // then: it patches the check run's output only
    expect(github.calls).toHaveLength(1)
    expect(github.calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.github.com/repos/acme/widgets/check-runs/555',
    })
    const output = github.calls[0]?.body.output as { title: string; summary: string }
    expect(github.calls[0]?.body.status).toBeUndefined()
    expect(output.title).toBe('Reviewing… (4m 12s)')
    expect(output.summary).toContain('re-review after new commits')
    expect(output.summary).toContain('| ✅ | Read the code (14 files) |')
    expect(output.summary).toContain('| ⏳ | Running commands (tests, builds) |')
    expect(output.summary).toContain('| ⬜ | Write up findings |')
    expect(output.summary).toContain('Last activity: 6 seconds ago')
  })

  test('progress in the posting phase says the review is being posted', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)

    await checks.progress?.(
      KEY,
      { mode: 'check-run', checkRunId: 555 },
      { phase: 'posting', startedAt: 0, now: 400_000, activity: null },
    )

    const output = github.calls[0]?.body.output as { title: string; summary: string }
    expect(output.title).toBe('Posting review… (6m 40s)')
  })

  test('requested changes render the findings table, review link, and duration', async () => {
    // given: a posted review with two findings
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)
    const details = reviewCheckDetails(42, [
      { path: 'src/auth/session.ts', line: 88, body: '**Token refresh can race with logout**\n\nDetails here.' },
      { path: 'src/api/client.ts', line: 40, body: '- Retry has | no upper bound' },
    ])

    // when: the check completes
    await checks.finish(
      KEY,
      { mode: 'check-run', checkRunId: 555 },
      { kind: 'verdict', state: 'CHANGES_REQUESTED', details },
      { startedAt: 0, decidedAt: 483_000, tracked: true },
    )

    // then: the page lists both findings with diff links and points Details at the review
    const body = github.calls[0]?.body as { output: { title: string; summary: string }; details_url: string }
    expect(body.details_url).toBe('https://github.com/acme/widgets/pull/7#pullrequestreview-42')
    expect(body.output.title).toBe('Changes requested · 2 findings')
    expect(body.output.summary).toContain('after a 8m 03s review')
    expect(body.output.summary).toContain('Token refresh can race with logout |')
    expect(body.output.summary).toContain('Retry has \\| no upper bound')
    expect(body.output.summary).toMatch(
      /\[`src\/auth\/session\.ts:88`\]\(https:\/\/github\.com\/acme\/widgets\/pull\/7\/files#diff-[0-9a-f]{64}R88\)/,
    )
    expect(body.output.summary).toContain('[View the full review →]')
  })

  test('an untracked verdict omits the duration and PAT statuses link to the review', async () => {
    const github = fakeGithub(() => json({}, 201))
    const checks = publisher('pat', github.fetchImpl)

    await checks.finish(
      KEY,
      { mode: 'status' },
      { kind: 'verdict', state: 'APPROVED', details: reviewCheckDetails(9, []) },
      { startedAt: 0, decidedAt: 60_000, tracked: false },
    )

    expect(github.calls[0]?.body.target_url).toBe('https://github.com/acme/widgets/pull/7#pullrequestreview-9')
  })

  test('review details cap the stored findings but keep the real count', () => {
    const comments = Array.from({ length: REVIEW_CHECK_MAX_FINDINGS + 5 }, (_, i) => ({
      path: 'a.ts',
      line: i + 1,
      body: '# 토큰 갱신 경쟁 상태',
    }))

    const details = reviewCheckDetails(1, comments)

    expect(details.findings).toHaveLength(REVIEW_CHECK_MAX_FINDINGS)
    expect(details.findingCount).toBe(REVIEW_CHECK_MAX_FINDINGS + 5)
    expect(details.findings?.[0]?.title).toBe('토큰 갱신 경쟁 상태')
  })

  test('failures and cancellations explain the reason and how to retry', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)
    const ref = { mode: 'check-run' as const, checkRunId: 1 }

    await checks.finish(KEY, ref, { kind: 'failed', reason: 'the reviewer did not finish in time' })
    await checks.finish(KEY, ref, { kind: 'cancelled', reason: 'the pull request was converted to draft' })

    const [failed, cancelled] = github.calls.map((c) => c.body.output as { title: string; summary: string })
    expect(failed?.title).toBe("Review didn't finish")
    expect(failed?.summary).toContain('Reason: the reviewer did not finish in time.')
    expect(failed?.summary).toContain('re-request a review')
    expect(cancelled?.title).toBe('Review skipped')
    expect(cancelled?.summary).toContain('Reason: the pull request was converted to draft.')
  })

  test('a finding on a deleted line links to the left side of the diff', async () => {
    const github = fakeGithub()
    const checks = publisher('app', github.fetchImpl)
    const details = reviewCheckDetails(1, [{ path: 'old.ts', line: 12, side: 'LEFT', body: 'Removed guard' }])

    await checks.finish(KEY, { mode: 'check-run', checkRunId: 1 }, { kind: 'verdict', state: 'COMMENTED', details })

    const output = github.calls[0]?.body.output as { summary: string }
    expect(details.findings?.[0]?.side).toBe('LEFT')
    expect(output.summary).toMatch(/#diff-[0-9a-f]{64}L12\)/)
  })

  test('a stalled progress request is aborted so the completion still publishes, with no progress after it', async () => {
    // given: a running check whose next progress PATCH hangs until it is aborted
    let hangProgress = true
    let progressEntered: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      progressEntered = resolve
    })
    const calls: string[] = []
    const fetchImpl = Object.assign(
      async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        const kind = init?.method === 'POST' ? 'start' : body.status === 'completed' ? 'complete' : 'progress'
        calls.push(kind)
        if (kind === 'progress' && hangProgress) {
          hangProgress = false
          progressEntered()
          const signal = init?.signal
          return new Promise<Response>((_, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason))
          })
        }
        return json({ id: 555 }, 201)
      },
      { preconnect: () => {} },
    )
    const checks = createGithubReviewCheckPublisher({
      token: async () => 'example-token',
      authType: 'app',
      enabled: () => true,
      checkName: () => 'typeclaw/review',
      logger: { warn: () => {} },
      fetchImpl,
      progressTimeoutMs: 5,
    })
    const tracker = new GithubReviewCheckTracker()
    await tracker.attach({
      publisher: checks,
      store: { load: async () => [], save: async () => {} },
      logger: { info: () => {}, warn: () => {} },
    })
    try {
      await tracker.beginReview(KEY, 'bg_1')

      // when: the sweep's progress stalls and the verdict is posted meanwhile
      const sweeping = tracker.sweep()
      await inFlight
      await tracker.reviewPosted(KEY, 'APPROVED')
      await sweeping
      await tracker.sweep()

      // then: the stalled request is abandoned, the completion lands, and nothing follows it
      expect(calls).toEqual(['start', 'progress', 'complete'])
    } finally {
      tracker.detach(checks)
    }
  })

  test('a stalled token lookup for progress is bounded too', async () => {
    const github = fakeGithub()
    const checks = createGithubReviewCheckPublisher({
      token: () => new Promise<string>(() => {}),
      authType: 'app',
      enabled: () => true,
      checkName: () => 'typeclaw/review',
      logger: { warn: () => {} },
      fetchImpl: github.fetchImpl,
      progressTimeoutMs: 5,
    })

    await checks.progress?.(
      KEY,
      { mode: 'check-run', checkRunId: 1 },
      { phase: 'posting', startedAt: 0, now: 0, activity: null },
    )

    expect(github.calls).toEqual([])
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

  test('round-trips a verdict outcome with review details', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-check-'))
    dirs.push(dir)
    const store = createReviewCheckLeaseStore(dir)
    const lease = {
      ...KEY,
      ref: { mode: 'check-run' as const, checkRunId: 9 },
      startedAt: 1,
      outcome: {
        kind: 'verdict' as const,
        state: 'COMMENTED' as const,
        details: { reviewId: 3, findings: [{ path: 'a.ts', line: 1, title: 'x' }], findingCount: 1 },
      },
      outcomeAt: 2,
    }

    await store.save([lease])

    expect(await createReviewCheckLeaseStore(dir).load()).toEqual([lease])
  })
})
