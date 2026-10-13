import { randomUUID } from 'node:crypto'

import { canonicalGithubRepo } from './github-repo'

// Shows the agent's own PR review as a GitHub check on the reviewed commit:
// in progress while a reviewer subagent works, completed with the verdict once
// the review is verified on GitHub. The tracker is a process-wide singleton
// (like the verdict coordinator) because its producers live on both sides of
// the agent/channel boundary: `spawn_subagent` begins and settles reviewer work,
// while the github adapter attaches the publisher and reports verified reviews.
//
// A check left `in_progress` stays that way on GitHub indefinitely, so every
// path must end it without relying on the model: reviewer settlement, a review
// that never posts (deadline sweep), cancellation, and a restart (durable lease
// file reaped on the next attach). A decided outcome is persisted with its lease
// and retried until GitHub acknowledges it, so a transient publish failure or a
// detached adapter cannot strand the check either.

// Fallback check name; the adapter names the check after the agent's GitHub
// identity once known (see `reviewCheckName`).
export const REVIEW_CHECK_NAME = 'typeclaw/review'

// Backstop for the reviewing phase. The reviewer subagent's own ceiling
// (REVIEWER_SPAWN_TIMEOUT_MS, 30m) normally settles it first as a failure; this
// only fires when that settlement never arrives.
export const REVIEW_CHECK_REVIEWING_DEADLINE_MS = 35 * 60_000

// The reviewer finished, but the parent session still has to post. A parent
// that wedges or dies here would otherwise leave the check spinning.
export const REVIEW_CHECK_POSTING_DEADLINE_MS = 10 * 60_000

export const REVIEW_CHECK_SWEEP_INTERVAL_MS = 60_000

// A decided outcome GitHub keeps rejecting as transient is abandoned after this
// long so a permanently broken repo cannot grow the lease file forever.
export const REVIEW_CHECK_PUBLISH_GIVE_UP_MS = 24 * 60 * 60_000

export type ReviewCheckKey = { repo: string; pullRequest: number; headSha: string }

export type ReviewCheckRef = { mode: 'check-run'; checkRunId: number } | { mode: 'status'; context?: string }

export type ReviewCheckFinding = { path: string; line: number; side?: 'LEFT' | 'RIGHT'; title: string }

// Persisted with the outcome, so it stays small: `findings` is capped and
// `findingCount` keeps the real total.
export type ReviewCheckVerdictDetails = {
  reviewId?: number
  findings?: ReviewCheckFinding[]
  findingCount?: number
}

export type ReviewCheckOutcome =
  | { kind: 'verdict'; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; details?: ReviewCheckVerdictDetails }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled'; reason: string }

export type ReviewerSettlement =
  | { kind: 'ok' }
  | { kind: 'failed'; reason: string }
  | { kind: 'cancelled'; reason: string }

// What a reviewer is doing, in plain categories: the check page never shows
// task ids, session ids, tool names, or model text.
export type ReviewerActivity = {
  started: boolean
  filesRead: number
  commandsRun: number
  current: 'reading' | 'commands' | 'writing' | null
  lastActivityAt: number | null
}

export type ReviewCheckProgress = {
  phase: 'reviewing' | 'posting'
  startedAt: number
  now: number
  reviewKind?: 'review' | 're-review'
  activity: ReviewerActivity | null
}

export type ReviewCheckTiming = { startedAt: number; decidedAt: number; tracked: boolean }

// 'published': GitHub has the outcome, or retrying cannot help (disabled, no
// permission). 'retry': a transient failure; the tracker keeps the outcome.
export type ReviewCheckPublishResult = 'published' | 'retry'

export type ReviewCheckPublisher = {
  // The name a new check (or commit-status context) is created under now.
  // Defaults to REVIEW_CHECK_NAME.
  name?: () => string
  // null: checks are disabled, not permitted, or the create failed — no check exists.
  start: (key: ReviewCheckKey) => Promise<ReviewCheckRef | null>
  // `ref: null` means no in-progress check exists; a publisher creates a
  // completed check directly for a verdict and ignores other outcomes.
  finish: (
    key: ReviewCheckKey,
    ref: ReviewCheckRef | null,
    outcome: ReviewCheckOutcome,
    timing?: ReviewCheckTiming,
  ) => Promise<ReviewCheckPublishResult>
  // Best effort: a lost progress update is replaced by the next one.
  progress?: (key: ReviewCheckKey, ref: ReviewCheckRef, progress: ReviewCheckProgress) => Promise<void>
}

// `ref: null` is only persisted together with an outcome: a verdict whose
// completed check still has to be created.
export type PersistedReviewCheckLease = ReviewCheckKey & {
  ref: ReviewCheckRef | null
  startedAt: number
  // Absent in records written before review durations were shown.
  tracked?: boolean
  outcome?: ReviewCheckOutcome
  outcomeAt?: number
}

export type ReviewCheckLeaseStore = {
  load: () => Promise<PersistedReviewCheckLease[]>
  save: (leases: PersistedReviewCheckLease[]) => Promise<void>
}

export type ReviewCheckLogger = { info: (m: string) => void; warn: (m: string) => void }

type Lease = {
  uid: string
  seq: number
  key: ReviewCheckKey
  // Only a check written under the same name can replace this one on GitHub.
  name: string
  startedAt: number
  owners: Set<string>
  ownerSucceeded: boolean
  phase: 'reviewing' | 'posting'
  deadlineAt: number
  // undefined while the start call is in flight.
  ref: ReviewCheckRef | null | undefined
  started: Promise<void>
  // False for a lease created only to publish a verdict nobody was tracked
  // reviewing; its duration means nothing.
  tracked: boolean
  reviewKind?: 'review' | 're-review'
  activity: ReviewerActivity | null
  outcome?: ReviewCheckOutcome
  outcomeAt?: number
  outcomeVersion: number
  publishing: Promise<void> | null
}

type Attachment = { publisher: ReviewCheckPublisher; store: ReviewCheckLeaseStore; logger: ReviewCheckLogger }

const RESTARTED_OUTCOME: ReviewCheckOutcome = {
  kind: 'failed',
  reason: 'TypeClaw restarted before this review was posted',
}

export class GithubReviewCheckTracker {
  private readonly leases = new Map<string, Lease>()
  private readonly leaseByTask = new Map<string, string>()
  private readonly publishLocks = new Map<string, Promise<void>>()
  // Newest lease per commit that owns a check on GitHub. Outlives that lease so
  // an older queued outcome stays superseded after the newer one publishes.
  private readonly newestCheckSeq = new Map<string, number>()
  private nextSeq = 0
  private attachment: Attachment | null = null
  // Kept across detach so a lease decided while no adapter is attached is still
  // persisted and published on the next attach.
  private store: { store: ReviewCheckLeaseStore; logger: ReviewCheckLogger } | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly now: () => number = Date.now) {}

  // Called on adapter start. A persisted lease this process does not hold was
  // written by a previous process: its decided outcome is republished, and an
  // undecided one died with that process's reviewer.
  async attach(attachment: Attachment): Promise<void> {
    this.attachment = attachment
    this.store = { store: attachment.store, logger: attachment.logger }
    if (this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => void this.sweep(), REVIEW_CHECK_SWEEP_INTERVAL_MS)
      this.sweepTimer.unref?.()
    }
    let persisted: PersistedReviewCheckLease[] = []
    try {
      persisted = await attachment.store.load()
    } catch (err) {
      attachment.logger.warn(`[github] review check leases unreadable: ${describe(err)}`)
    }
    let restored = 0
    for (const record of persisted) {
      if (this.holds(record)) continue
      const lease = this.createLease(normalizeKey(record), record.startedAt)
      lease.ref = record.ref
      if (record.ref?.mode === 'status') lease.name = record.ref.context ?? REVIEW_CHECK_NAME
      lease.tracked = record.tracked === true
      this.claimCheck(lease)
      this.decide(lease, record.outcome ?? RESTARTED_OUTCOME, record.outcomeAt)
      restored++
    }
    if (restored > 0) {
      attachment.logger.info(`[github] closing ${restored} review check(s) left by a previous process`)
      await this.persist()
    }
    await this.publishDecided()
  }

  detach(publisher: ReviewCheckPublisher): void {
    if (this.attachment?.publisher !== publisher) return
    this.attachment = null
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  beginReview(
    key: ReviewCheckKey,
    taskId: string,
    options: { reviewKind?: 'review' | 're-review' } = {},
  ): Promise<void> {
    const attachment = this.attachment
    if (attachment === null) return Promise.resolve()
    const normalized = normalizeKey(key)
    const existing = this.openLease(normalized)
    if (existing !== undefined) {
      this.leaseByTask.set(taskId, existing.uid)
      existing.owners.add(taskId)
      existing.phase = 'reviewing'
      existing.deadlineAt = this.now() + REVIEW_CHECK_REVIEWING_DEADLINE_MS
      if (options.reviewKind !== undefined) existing.reviewKind = options.reviewKind
      return existing.started
    }
    const lease = this.createLease(normalized, this.now())
    lease.tracked = true
    if (options.reviewKind !== undefined) lease.reviewKind = options.reviewKind
    this.leaseByTask.set(taskId, lease.uid)
    lease.owners.add(taskId)
    lease.started = attachment.publisher
      .start(normalized)
      .then(
        (ref) => {
          lease.ref = ref
          if (ref?.mode === 'status' && ref.context !== undefined) lease.name = ref.context
        },
        (err: unknown) => {
          attachment.logger.warn(`[github] review check start failed for ${leaseId(normalized)}: ${describe(err)}`)
          lease.ref = null
        },
      )
      .then(() => this.afterStart(lease))
    return lease.started
  }

  reviewerSettled(taskId: string, settlement: ReviewerSettlement): Promise<void> {
    const uid = this.leaseByTask.get(taskId)
    if (uid === undefined) return Promise.resolve()
    this.leaseByTask.delete(taskId)
    const lease = this.leases.get(uid)
    if (lease === undefined || lease.outcome !== undefined || !lease.owners.delete(taskId)) return Promise.resolve()
    if (settlement.kind === 'ok') lease.ownerSucceeded = true
    // A sibling reviewer for the same commit is still working; its settlement decides.
    if (lease.owners.size > 0) return Promise.resolve()
    if (lease.ownerSucceeded) {
      lease.phase = 'posting'
      lease.deadlineAt = this.now() + REVIEW_CHECK_POSTING_DEADLINE_MS
      return this.publishProgress(lease)
    }
    return this.finish(lease, settlement.kind === 'ok' ? { kind: 'failed', reason: 'reviewer failed' } : settlement)
  }

  // The latest snapshot wins; it is published on the next sweep tick, which
  // bounds progress PATCHes to one per lease per sweep interval.
  reportActivity(taskId: string, activity: ReviewerActivity): void {
    const uid = this.leaseByTask.get(taskId)
    const lease = uid === undefined ? undefined : this.leases.get(uid)
    if (lease === undefined || lease.outcome !== undefined) return
    lease.activity = activity
  }

  async reviewPosted(
    key: ReviewCheckKey,
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
    details?: ReviewCheckVerdictDetails,
  ): Promise<void> {
    const normalized = normalizeKey(key)
    const outcome: ReviewCheckOutcome = { kind: 'verdict', state, ...(details !== undefined ? { details } : {}) }
    const open = this.openLease(normalized)
    if (open !== undefined) return this.finish(open, outcome)
    // A verdict that lands after a failure was decided but before GitHub has
    // it supersedes that failure.
    const pending = [...this.leases.values()].find(
      (lease) => lease.outcome !== undefined && sameKey(lease.key, normalized) && lease.ref !== null,
    )
    if (pending !== undefined) return this.finish(pending, outcome, { supersede: true })
    // A review posted without a tracked reviewer (or after its lease closed)
    // still deserves its verdict on the commit.
    if (this.attachment === null) return
    const lease = this.createLease(normalized, this.now())
    lease.ref = null
    this.claimCheck(lease)
    return this.finish(lease, outcome, { createIfMissing: true })
  }

  // For a verdict posted without the reviewed head: only reviews that already
  // finished on this PR can be the ones it reports.
  async completePostingReviews(
    repo: string,
    pullRequest: number,
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED',
  ): Promise<void> {
    const canonical = canonicalGithubRepo(repo)
    const matching = [...this.leases.values()].filter(
      (lease) =>
        lease.outcome === undefined &&
        lease.phase === 'posting' &&
        lease.key.repo === canonical &&
        lease.key.pullRequest === pullRequest,
    )
    await Promise.all(matching.map((lease) => this.finish(lease, { kind: 'verdict', state })))
  }

  async cancelPullRequest(repo: string, pullRequest: number, reason: string): Promise<void> {
    const canonical = canonicalGithubRepo(repo)
    const matching = [...this.leases.values()].filter(
      (lease) => lease.outcome === undefined && lease.key.repo === canonical && lease.key.pullRequest === pullRequest,
    )
    await Promise.all(matching.map((lease) => this.finish(lease, { kind: 'cancelled', reason })))
  }

  async sweep(): Promise<void> {
    const now = this.now()
    const expired = [...this.leases.values()].filter((lease) => lease.outcome === undefined && lease.deadlineAt <= now)
    await Promise.all(
      expired.map((lease) =>
        this.finish(lease, {
          kind: 'failed',
          reason:
            lease.phase === 'posting'
              ? 'the review finished but was not posted in time'
              : 'the reviewer did not finish in time',
        }),
      ),
    )
    await this.publishDecided()
    const open = [...this.leases.values()].filter((lease) => lease.outcome === undefined)
    await Promise.all(open.map((lease) => this.publishProgress(lease)))
  }

  private createLease(key: ReviewCheckKey, startedAt: number): Lease {
    const lease: Lease = {
      uid: randomUUID(),
      seq: this.nextSeq++,
      key,
      name: this.attachment?.publisher.name?.() ?? REVIEW_CHECK_NAME,
      startedAt,
      owners: new Set(),
      ownerSucceeded: false,
      phase: 'reviewing',
      deadlineAt: this.now() + REVIEW_CHECK_REVIEWING_DEADLINE_MS,
      ref: undefined,
      started: Promise.resolve(),
      tracked: false,
      activity: null,
      outcomeVersion: 0,
      publishing: null,
    }
    this.leases.set(lease.uid, lease)
    return lease
  }

  private async afterStart(lease: Lease): Promise<void> {
    if (lease.ref === null) {
      // No check exists, so there is nothing to complete or recover.
      if (lease.outcome !== undefined) this.drop(lease)
      return
    }
    this.claimCheck(lease)
    await this.persist()
    if (lease.outcome !== undefined) await this.publish(lease)
  }

  private async finish(
    lease: Lease,
    outcome: ReviewCheckOutcome,
    options: { supersede?: boolean; createIfMissing?: boolean } = {},
  ): Promise<void> {
    if (lease.outcome !== undefined && options.supersede !== true) return
    this.decide(lease, outcome)
    for (const owner of lease.owners) this.leaseByTask.delete(owner)
    lease.owners.clear()
    if (lease.ref === undefined) return lease.started
    if (lease.ref === null && options.createIfMissing !== true) {
      this.drop(lease)
      return
    }
    await this.persist()
    await this.publish(lease)
  }

  private decide(lease: Lease, outcome: ReviewCheckOutcome, at?: number): void {
    lease.outcome = outcome
    lease.outcomeAt = at ?? this.now()
    lease.outcomeVersion += 1
  }

  private async publishDecided(): Promise<void> {
    const decided = [...this.leases.values()].filter((lease) => lease.outcome !== undefined && lease.ref !== undefined)
    await Promise.all(decided.map((lease) => this.publish(lease)))
  }

  // Publishes for one commit run one at a time: commit statuses (and a
  // completed check created from no ref) share one name on the commit, so
  // whichever lands last is what GitHub shows.
  private publish(lease: Lease): Promise<void> {
    if (lease.publishing !== null) return lease.publishing
    lease.publishing = this.withPublishLock(lease.key, () => this.publishUntilCurrent(lease)).finally(() => {
      lease.publishing = null
    })
    return lease.publishing
  }

  // Shares the completion's per-commit lock, and re-checks for an outcome once
  // it holds it, so a progress update can never land after the completed check.
  private publishProgress(lease: Lease): Promise<void> {
    if (lease.ref?.mode !== 'check-run' || this.attachment?.publisher.progress === undefined) return Promise.resolve()
    return this.withPublishLock(lease.key, async () => {
      const attachment = this.attachment
      const progress = attachment?.publisher.progress
      const ref = lease.ref
      if (progress === undefined || lease.outcome !== undefined || ref?.mode !== 'check-run') return
      if (this.leases.get(lease.uid) !== lease) return
      try {
        await progress(lease.key, ref, {
          phase: lease.phase,
          startedAt: lease.startedAt,
          now: this.now(),
          ...(lease.reviewKind !== undefined ? { reviewKind: lease.reviewKind } : {}),
          activity: lease.activity,
        })
      } catch (err) {
        attachment?.logger.warn(`[github] review check progress failed for ${leaseId(lease.key)}: ${describe(err)}`)
      }
    }).catch(() => {})
  }

  private withPublishLock(key: ReviewCheckKey, fn: () => Promise<void>): Promise<void> {
    const lockId = leaseId(key)
    const run = (this.publishLocks.get(lockId) ?? Promise.resolve()).then(fn)
    const tail = run.catch(() => {})
    this.publishLocks.set(lockId, tail)
    void tail.then(() => {
      if (this.publishLocks.get(lockId) === tail) this.publishLocks.delete(lockId)
    })
    return run
  }

  private async publishUntilCurrent(lease: Lease): Promise<void> {
    for (;;) {
      const attachment = this.attachment
      const outcome = lease.outcome
      if (attachment === null || outcome === undefined || lease.ref === undefined) return
      if (this.isSuperseded(lease)) {
        this.drop(lease)
        await this.persist()
        return
      }
      const version = lease.outcomeVersion
      let result: ReviewCheckPublishResult
      try {
        result = await attachment.publisher.finish(lease.key, lease.ref, outcome, {
          startedAt: lease.startedAt,
          decidedAt: lease.outcomeAt ?? this.now(),
          tracked: lease.tracked,
        })
      } catch (err) {
        attachment.logger.warn(`[github] review check finish failed for ${leaseId(lease.key)}: ${describe(err)}`)
        result = 'retry'
      }
      if (result === 'retry') {
        if (this.now() - (lease.outcomeAt ?? this.now()) >= REVIEW_CHECK_PUBLISH_GIVE_UP_MS) {
          attachment.logger.warn(
            `[github] giving up on review check ${leaseId(lease.key)}: GitHub kept rejecting its completion`,
          )
          this.drop(lease)
          await this.persist()
        }
        return
      }
      if (version === lease.outcomeVersion) {
        this.drop(lease)
        await this.persist()
        return
      }
    }
  }

  // A queued outcome that would write a shared commit-status context (or
  // create a new check run) must not overwrite a newer review of the same
  // commit under the same name. An App check run has its own id, and a check
  // under another name is a separate check, so completing either stays safe.
  private isSuperseded(lease: Lease): boolean {
    if (lease.ref?.mode === 'check-run') return false
    if ((this.newestCheckSeq.get(checkId(lease)) ?? -1) > lease.seq) return true
    // A newer review whose check is still being created will overwrite it too.
    return [...this.leases.values()].some(
      (other) =>
        other.seq > lease.seq && other.ref === undefined && sameKey(other.key, lease.key) && other.name === lease.name,
    )
  }

  // Older decided outcomes this lease supersedes are retired right away, not at
  // their next publish, so the persisted snapshot never holds one a restart
  // could replay over the newer review.
  private claimCheck(lease: Lease): void {
    const id = checkId(lease)
    this.newestCheckSeq.set(id, Math.max(this.newestCheckSeq.get(id) ?? -1, lease.seq))
    for (const older of this.leases.values()) {
      if (
        older.seq < lease.seq &&
        older.outcome !== undefined &&
        older.ref !== undefined &&
        older.ref?.mode !== 'check-run' &&
        sameKey(older.key, lease.key) &&
        older.name === lease.name
      ) {
        this.leases.delete(older.uid)
      }
    }
  }

  private drop(lease: Lease): void {
    if (this.leases.get(lease.uid) === lease) this.leases.delete(lease.uid)
    if (![...this.leases.values()].some((other) => sameKey(other.key, lease.key) && other.name === lease.name)) {
      this.newestCheckSeq.delete(checkId(lease))
    }
  }

  private openLease(key: ReviewCheckKey): Lease | undefined {
    return [...this.leases.values()].find((lease) => lease.outcome === undefined && sameKey(lease.key, key))
  }

  private holds(record: PersistedReviewCheckLease): boolean {
    const key = normalizeKey(record)
    return [...this.leases.values()].some((lease) => sameKey(lease.key, key) && sameRef(lease.ref, record.ref))
  }

  private persist(): Promise<void> {
    const target = this.store
    if (target === null) return this.persistChain
    const snapshot: PersistedReviewCheckLease[] = [...this.leases.values()].flatMap((lease) => {
      if (lease.ref === undefined || (lease.ref === null && lease.outcome === undefined)) return []
      return [
        {
          ...lease.key,
          ref: lease.ref,
          startedAt: lease.startedAt,
          ...(lease.tracked ? { tracked: true } : {}),
          ...(lease.outcome !== undefined ? { outcome: lease.outcome, outcomeAt: lease.outcomeAt } : {}),
        },
      ]
    })
    this.persistChain = this.persistChain
      .then(() => target.store.save(snapshot))
      .catch((err: unknown) => {
        target.logger.warn(`[github] review check leases not persisted: ${describe(err)}`)
      })
    return this.persistChain
  }
}

export const githubReviewChecks = new GithubReviewCheckTracker()

function normalizeKey(key: ReviewCheckKey): ReviewCheckKey {
  return { repo: canonicalGithubRepo(key.repo), pullRequest: key.pullRequest, headSha: key.headSha.toLowerCase() }
}

function sameKey(a: ReviewCheckKey, b: ReviewCheckKey): boolean {
  return a.repo === b.repo && a.pullRequest === b.pullRequest && a.headSha === b.headSha
}

function sameRef(a: ReviewCheckRef | null | undefined, b: ReviewCheckRef | null): boolean {
  if (a === undefined || a === null || b === null) return a === b
  if (a.mode === 'check-run' && b.mode === 'check-run') return a.checkRunId === b.checkRunId
  if (a.mode === 'status' && b.mode === 'status') {
    return (a.context ?? REVIEW_CHECK_NAME) === (b.context ?? REVIEW_CHECK_NAME)
  }
  return false
}

function checkId(lease: Lease): string {
  return `${leaseId(lease.key)}:${lease.name}`
}

function leaseId(key: ReviewCheckKey): string {
  return `${canonicalGithubRepo(key.repo)}#${key.pullRequest}@${key.headSha.toLowerCase()}`
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
