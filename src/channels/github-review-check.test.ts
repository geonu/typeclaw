import { afterEach, describe, expect, test } from 'bun:test'

import {
  GithubReviewCheckTracker,
  type PersistedReviewCheckLease,
  REVIEW_CHECK_POSTING_DEADLINE_MS,
  REVIEW_CHECK_PUBLISH_GIVE_UP_MS,
  REVIEW_CHECK_REVIEWING_DEADLINE_MS,
  type ReviewCheckKey,
  type ReviewCheckOutcome,
  type ReviewCheckPublisher,
  type ReviewCheckPublishResult,
  type ReviewCheckRef,
  type ReviewCheckTiming,
} from './github-review-check'

const KEY: ReviewCheckKey = { repo: 'Acme/Widgets', pullRequest: 7, headSha: 'A'.repeat(40) }
const NORMALIZED: ReviewCheckKey = { repo: 'acme/widgets', pullRequest: 7, headSha: 'a'.repeat(40) }
const RUN: ReviewCheckRef = { mode: 'check-run', checkRunId: 99 }

type Finished = { key: ReviewCheckKey; ref: ReviewCheckRef | null; outcome: ReviewCheckOutcome }

function harness(
  options: {
    start?: (key: ReviewCheckKey) => Promise<ReviewCheckRef | null>
    persisted?: PersistedReviewCheckLease[]
    name?: string
  } = {},
) {
  let clock = 1_000
  const started: ReviewCheckKey[] = []
  const finished: Finished[] = []
  const timings: Array<ReviewCheckTiming | undefined> = []
  const publishResults: ReviewCheckPublishResult[] = []
  let saved: PersistedReviewCheckLease[] = options.persisted ?? []
  const publisher: ReviewCheckPublisher = {
    ...(options.name !== undefined ? { name: () => options.name! } : {}),
    start: async (key) => {
      started.push(key)
      return options.start === undefined ? RUN : options.start(key)
    },
    finish: async (key, ref, outcome, timing) => {
      finished.push({ key, ref, outcome })
      timings.push(timing)
      return publishResults.shift() ?? 'published'
    },
  }
  const tracker = new GithubReviewCheckTracker(() => clock)
  const attach = () =>
    tracker.attach({
      publisher,
      store: {
        load: async () => saved,
        save: async (leases) => {
          saved = leases
        },
      },
      logger: { info: () => {}, warn: () => {} },
    })
  detachers.push(() => tracker.detach(publisher))
  return {
    tracker,
    started,
    finished,
    timings,
    attach,
    detach: () => tracker.detach(publisher),
    failNextPublish: () => publishResults.push('retry'),
    saved: () => saved,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const detachers: Array<() => void> = []
afterEach(() => {
  for (const detach of detachers.splice(0)) detach()
})

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('GithubReviewCheckTracker', () => {
  test('starts a check when a reviewer begins and completes it with the posted verdict', async () => {
    const h = harness()
    await h.attach()

    await h.tracker.beginReview(KEY, 'bg_1')
    expect(h.started).toEqual([NORMALIZED])
    expect(h.saved()).toHaveLength(1)

    await h.tracker.reviewerSettled('bg_1', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'CHANGES_REQUESTED')

    expect(h.finished).toEqual([
      { key: NORMALIZED, ref: RUN, outcome: { kind: 'verdict', state: 'CHANGES_REQUESTED' } },
    ])
    expect(h.saved()).toEqual([])
  })

  test('a failed reviewer fails the check immediately', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')

    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })

    expect(h.finished.map((f) => f.outcome)).toEqual([{ kind: 'failed', reason: 'model error' }])
  })

  test('a cancelled reviewer cancels the check instead of failing it', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')

    await h.tracker.reviewerSettled('bg_1', { kind: 'cancelled', reason: 'the review was cancelled' })

    expect(h.finished.map((f) => f.outcome.kind)).toEqual(['cancelled'])
  })

  test('a finished review that is never posted fails once the posting deadline passes', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.reviewerSettled('bg_1', { kind: 'ok' })

    h.advance(REVIEW_CHECK_POSTING_DEADLINE_MS - 1)
    await h.tracker.sweep()
    expect(h.finished).toEqual([])

    h.advance(1)
    await h.tracker.sweep()
    expect(h.finished.map((f) => f.outcome)).toEqual([
      { kind: 'failed', reason: 'the review finished but was not posted in time' },
    ])
  })

  test('a reviewer that never settles fails once the reviewing deadline passes', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')

    h.advance(REVIEW_CHECK_REVIEWING_DEADLINE_MS)
    await h.tracker.sweep()

    expect(h.finished.map((f) => f.outcome)).toEqual([
      { kind: 'failed', reason: 'the reviewer did not finish in time' },
    ])
    expect(h.saved()).toEqual([])
  })

  test('a sibling reviewer for the same commit keeps one check alive until both settle', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.beginReview(KEY, 'bg_2')

    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'boom' })
    await h.tracker.reviewerSettled('bg_2', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')

    expect(h.started).toHaveLength(1)
    expect(h.finished.map((f) => f.outcome)).toEqual([{ kind: 'verdict', state: 'APPROVED' }])
  })

  test('cancelling a pull request cancels its in-progress checks only', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.beginReview({ ...KEY, pullRequest: 8 }, 'bg_2')

    await h.tracker.cancelPullRequest('acme/WIDGETS', 7, 'the pull request was converted to draft')

    expect(h.finished).toEqual([
      { key: NORMALIZED, ref: RUN, outcome: { kind: 'cancelled', reason: 'the pull request was converted to draft' } },
    ])
  })

  test('a verdict posted without the reviewed head completes only reviews already waiting to post', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.beginReview({ ...KEY, headSha: 'b'.repeat(40) }, 'bg_2')
    await h.tracker.reviewerSettled('bg_1', { kind: 'ok' })

    await h.tracker.completePostingReviews('acme/widgets', 7, 'CHANGES_REQUESTED')

    expect(h.finished).toEqual([
      { key: NORMALIZED, ref: RUN, outcome: { kind: 'verdict', state: 'CHANGES_REQUESTED' } },
    ])
  })

  test('a review posted without a tracked reviewer still publishes its verdict', async () => {
    const h = harness()
    await h.attach()

    await h.tracker.reviewPosted(KEY, 'COMMENTED')

    expect(h.finished).toEqual([{ key: NORMALIZED, ref: null, outcome: { kind: 'verdict', state: 'COMMENTED' } }])
    expect(h.saved()).toEqual([])
  })

  test('a publish GitHub rejects keeps the outcome and the next sweep closes the original check with it', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()

    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })
    expect(h.saved()).toEqual([
      {
        ...NORMALIZED,
        ref: RUN,
        startedAt: 1_000,
        tracked: true,
        outcome: { kind: 'failed', reason: 'model error' },
        outcomeAt: 1_000,
      },
    ])

    await h.tracker.sweep()

    expect(h.finished.map((f) => [f.ref, f.outcome])).toEqual([
      [RUN, { kind: 'failed', reason: 'model error' }],
      [RUN, { kind: 'failed', reason: 'model error' }],
    ])
    expect(h.saved()).toEqual([])
  })

  test('an outcome decided while detached is published with the original outcome on re-attach', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.detach()

    await h.tracker.reviewerSettled('bg_1', { kind: 'cancelled', reason: 'the review was cancelled' })
    expect(h.finished).toEqual([])
    expect(h.saved()[0]?.outcome).toEqual({ kind: 'cancelled', reason: 'the review was cancelled' })

    await h.attach()

    expect(h.finished).toEqual([
      { key: NORMALIZED, ref: RUN, outcome: { kind: 'cancelled', reason: 'the review was cancelled' } },
    ])
    expect(h.saved()).toEqual([])
  })

  test('an outcome decided before the start call returns closes the check once it exists', async () => {
    const start = deferred<ReviewCheckRef | null>()
    const h = harness({ start: () => start.promise })
    await h.attach()
    const begun = h.tracker.beginReview(KEY, 'bg_1')

    const settled = h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })
    expect(h.finished).toEqual([])
    start.resolve(RUN)
    await Promise.all([begun, settled])

    expect(h.finished).toEqual([{ key: NORMALIZED, ref: RUN, outcome: { kind: 'failed', reason: 'model error' } }])
    expect(h.saved()).toEqual([])
  })

  test('a verdict that lands while a failure is still unpublished replaces the failure', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })

    await h.tracker.reviewPosted(KEY, 'APPROVED')

    expect(h.finished.at(-1)).toEqual({ key: NORMALIZED, ref: RUN, outcome: { kind: 'verdict', state: 'APPROVED' } })
    expect(h.saved()).toEqual([])
  })

  test('a queued commit-status failure never overwrites a replacement review of the same commit', async () => {
    // given: a PAT-mode check whose failure GitHub rejected transiently
    const h = harness({ start: async () => ({ mode: 'status' }) })
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })

    // when: a replacement review of the same commit is approved, then the sweep runs
    await h.tracker.beginReview(KEY, 'bg_2')
    await h.tracker.reviewerSettled('bg_2', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')
    await h.tracker.sweep()

    // then: the approval is the last thing published and the stale failure is gone
    expect(h.finished.map((f) => f.outcome)).toEqual([
      { kind: 'failed', reason: 'model error' },
      { kind: 'verdict', state: 'APPROVED' },
    ])
    expect(h.saved()).toEqual([])
  })

  test('a restart right after a replacement approval never replays the obsolete commit-status failure', async () => {
    // given: a PAT failure GitHub rejected, then a replacement review approved on the same commit
    const h = harness({ start: async () => ({ mode: 'status' }) })
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })
    await h.tracker.beginReview(KEY, 'bg_2')
    await h.tracker.reviewerSettled('bg_2', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')

    // when: the process restarts before any sweep
    const restarted = harness({ start: async () => ({ mode: 'status' }), persisted: h.saved() })
    await restarted.attach()

    // then: nothing obsolete was saved, so the restart publishes nothing over the approval
    expect(h.saved()).toEqual([])
    expect(restarted.finished).toEqual([])
  })

  test('a pending status under an older check name survives a new-name review of the same commit', async () => {
    // given: a legacy pending status restored after an upgrade, whose completion GitHub rejects
    const legacy: PersistedReviewCheckLease = { ...NORMALIZED, ref: { mode: 'status' }, startedAt: 1 }
    const h = harness({
      name: 'my-agent',
      start: async () => ({ mode: 'status', context: 'my-agent' }),
      persisted: [legacy],
    })
    h.failNextPublish()
    await h.attach()

    // when: a review starts and is approved under the new name, then the sweep retries
    await h.tracker.beginReview(KEY, 'bg_1')
    expect(h.saved().map((l) => l.ref)).toEqual([{ mode: 'status' }, { mode: 'status', context: 'my-agent' }])
    await h.tracker.reviewerSettled('bg_1', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')
    await h.tracker.sweep()

    // then: the legacy status is still completed, separately from the new one
    expect(h.finished.map((f) => [f.ref, f.outcome.kind])).toEqual([
      [{ mode: 'status' }, 'failed'],
      [{ mode: 'status', context: 'my-agent' }, 'verdict'],
      [{ mode: 'status' }, 'failed'],
    ])
    expect(h.saved()).toEqual([])
  })

  test('a restart right after a replacement approval still closes an independent App check run', async () => {
    let id = 0
    const h = harness({ start: async () => ({ mode: 'check-run', checkRunId: ++id }) })
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })
    await h.tracker.beginReview(KEY, 'bg_2')
    await h.tracker.reviewerSettled('bg_2', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')

    const restarted = harness({ persisted: h.saved() })
    await restarted.attach()

    expect(restarted.finished).toEqual([
      {
        key: NORMALIZED,
        ref: { mode: 'check-run', checkRunId: 1 },
        outcome: { kind: 'failed', reason: 'model error' },
      },
    ])
    expect(restarted.saved()).toEqual([])
  })

  test('an App check run left by a failed publish is still closed after a replacement review', async () => {
    let id = 0
    const h = harness({ start: async () => ({ mode: 'check-run', checkRunId: ++id }) })
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })

    await h.tracker.beginReview(KEY, 'bg_2')
    await h.tracker.reviewerSettled('bg_2', { kind: 'ok' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')
    await h.tracker.sweep()

    expect(h.finished.map((f) => [f.ref, f.outcome.kind])).toEqual([
      [{ mode: 'check-run', checkRunId: 1 }, 'failed'],
      [{ mode: 'check-run', checkRunId: 2 }, 'verdict'],
      [{ mode: 'check-run', checkRunId: 1 }, 'failed'],
    ])
    expect(h.saved()).toEqual([])
  })

  test('a publish GitHub keeps rejecting is abandoned after the give-up window', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.failNextPublish()
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'model error' })

    h.advance(REVIEW_CHECK_PUBLISH_GIVE_UP_MS)
    h.failNextPublish()
    await h.tracker.sweep()

    expect(h.saved()).toEqual([])
    await h.tracker.sweep()
    expect(h.finished).toHaveLength(2)
  })

  test('attach fails undecided checks a previous process left and republishes decided ones', async () => {
    const undecided: PersistedReviewCheckLease = {
      ...NORMALIZED,
      pullRequest: 3,
      ref: { mode: 'status' },
      startedAt: 1,
    }
    const decided: PersistedReviewCheckLease = {
      ...NORMALIZED,
      pullRequest: 4,
      ref: RUN,
      startedAt: 1,
      outcome: { kind: 'verdict', state: 'APPROVED' },
      outcomeAt: 1,
    }
    const h = harness({ persisted: [undecided, decided] })

    await h.attach()

    expect(h.finished).toEqual([
      {
        key: { ...NORMALIZED, pullRequest: 3 },
        ref: { mode: 'status' },
        outcome: { kind: 'failed', reason: 'TypeClaw restarted before this review was posted' },
      },
      { key: { ...NORMALIZED, pullRequest: 4 }, ref: RUN, outcome: { kind: 'verdict', state: 'APPROVED' } },
    ])
    expect(h.saved()).toEqual([])
  })

  test('re-attaching mid-review (adapter restart in the same process) keeps the live check', async () => {
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')

    await h.attach()

    expect(h.finished).toEqual([])
    expect(h.saved()).toHaveLength(1)
  })

  test('nothing starts while no adapter is attached', async () => {
    const h = harness()

    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'boom' })
    await h.tracker.reviewPosted(KEY, 'APPROVED')

    expect(h.started).toEqual([])
    expect(h.finished).toEqual([])
  })

  test('a skipped check (no permission) never publishes a completion', async () => {
    const h = harness({ start: async () => null })
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')

    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'boom' })

    expect(h.finished).toEqual([])
    expect(h.saved()).toEqual([])
  })
})

describe('GithubReviewCheckTracker progress', () => {
  function progressHarness() {
    let clock = 1_000
    const events: string[] = []
    const progress: Array<{ phase: string; activity: unknown }> = []
    const gate = deferred<void>()
    const entered = deferred<void>()
    let holdProgress = false
    const publisher: ReviewCheckPublisher = {
      start: async () => RUN,
      finish: async (_key, _ref, outcome) => {
        events.push(`finish:${outcome.kind}`)
        return 'published'
      },
      progress: async (_key, _ref, p) => {
        if (holdProgress) {
          entered.resolve()
          await gate.promise
        }
        events.push(`progress:${p.phase}`)
        progress.push({ phase: p.phase, activity: p.activity })
      },
    }
    const tracker = new GithubReviewCheckTracker(() => clock)
    detachers.push(() => tracker.detach(publisher))
    return {
      tracker,
      events,
      progress,
      hold: () => {
        holdProgress = true
      },
      inFlight: entered.promise,
      release: () => gate.resolve(),
      advance: (ms: number) => {
        clock += ms
      },
      attach: () =>
        tracker.attach({
          publisher,
          store: { load: async () => [], save: async () => {} },
          logger: { info: () => {}, warn: () => {} },
        }),
    }
  }

  const ACTIVITY = { started: true, filesRead: 3, commandsRun: 1, current: 'reading' as const, lastActivityAt: 1_500 }

  test('the sweep publishes the latest reported reviewer activity for a running check', async () => {
    const h = progressHarness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1', { reviewKind: 're-review' })

    h.tracker.reportActivity('bg_1', ACTIVITY)
    await h.tracker.sweep()

    expect(h.progress).toEqual([{ phase: 'reviewing', activity: ACTIVITY }])
  })

  test('a successful reviewer publishes the posting phase at once', async () => {
    const h = progressHarness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')

    await h.tracker.reviewerSettled('bg_1', { kind: 'ok' })

    expect(h.events).toEqual(['progress:posting'])
  })

  test('an in-flight progress update never lands after the completed check', async () => {
    // given: a progress update that is still in flight
    const h = progressHarness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    h.hold()
    const sweeping = h.tracker.sweep()
    await h.inFlight

    // when: the verdict arrives meanwhile, then the progress call returns
    const posted = h.tracker.reviewPosted(KEY, 'APPROVED')
    expect(h.events).toEqual([])
    h.release()
    await Promise.all([sweeping, posted])
    await h.tracker.sweep()

    // then: the completion is published last and no progress follows it
    expect(h.events).toEqual(['progress:reviewing', 'finish:verdict'])
  })

  test('activity for an unknown or finished review is ignored', async () => {
    const h = progressHarness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.reviewerSettled('bg_1', { kind: 'failed', reason: 'boom' })

    h.tracker.reportActivity('bg_1', ACTIVITY)
    h.tracker.reportActivity('bg_unknown', ACTIVITY)
    await h.tracker.sweep()

    expect(h.progress).toEqual([])
  })
})

describe('GithubReviewCheckTracker restart timing', () => {
  test('a tracked verdict replayed after a restart keeps its review duration; an untracked one does not', async () => {
    // given: a tracked review whose verdict publish fails, and an untracked verdict on another commit
    const h = harness()
    await h.attach()
    await h.tracker.beginReview(KEY, 'bg_1')
    await h.tracker.reviewerSettled('bg_1', { kind: 'ok' })
    h.advance(60_000)
    h.failNextPublish()
    await h.tracker.reviewPosted(KEY, 'APPROVED')
    h.failNextPublish()
    await h.tracker.reviewPosted({ ...KEY, headSha: 'b'.repeat(40) }, 'COMMENTED')

    // when: the process restarts and republishes both
    const restarted = harness({ persisted: h.saved() })
    await restarted.attach()

    // then: only the tracked one carries a duration-bearing timing
    expect(h.saved().map((lease) => lease.tracked === true)).toEqual([true, false])
    expect(restarted.timings.map((timing) => timing?.tracked)).toEqual([true, false])
    expect(restarted.timings[0]).toMatchObject({ startedAt: 1_000, decidedAt: 61_000 })
  })
})
