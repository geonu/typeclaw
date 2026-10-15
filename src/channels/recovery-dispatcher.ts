import type { BackgroundObligationStore } from './background-obligations'
import type { RecoveryRecord } from './continuity-types'
import type { InboundJournal } from './inbound-journal'
import type { RecoveryOutbox } from './recovery-outbox'
import type { ChannelRouter } from './router'
import { channelKeyId, type ChannelKey, type RecoveryRedelivery } from './types'

// Bounds how long a restart notice waits for an adapter still deciding whether it re-admitted the
// interrupted work (GitHub's boot reconcile pass), so a stuck pass delays the notice, never loses it.
const REDELIVERY_WAIT_MS = 5 * 60_000

/** Transport-only recovery; each destination progresses independently. */
export class RecoveryDispatcher {
  private readonly lanes = new Map<string, Promise<void>>()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  /** Set by the first (boot) wake; imports never dispatch before adapters are ready. */
  private woken = false
  private readonly unsubscribe: () => void
  /** Destinations whose due work was skipped while an earlier pass still held their lane. */
  private readonly deferred = new Set<string>()

  constructor(
    private readonly outbox: RecoveryOutbox,
    private readonly router: ChannelRouter,
    private readonly options: {
      now?: () => number
      consistencyDelayMs?: number
      onError?: (error: unknown) => void
      backgroundObligations?: BackgroundObligationStore
      inboundJournal?: InboundJournal
    } = {},
  ) {
    router.setRecoveryStopHandler((target, parent) => this.suppressParent(target, parent))
    // A transfer made durable after boot (a live turn that ended unanswered) dispatches now
    // instead of at the next poll; multiple imports in one tick coalesce into one wake.
    this.unsubscribe = outbox.subscribe(() => {
      if (!this.woken || this.stopped) return
      clearTimeout(this.timer)
      this.timer = undefined
      this.schedule(0)
    })
  }

  private async validateCoverageInLane(record: RecoveryRecord): Promise<'open' | 'resolved'> {
    if (record.covers.some((cover) => cover.store === 'inbound')) {
      if (!this.options.inboundJournal) throw new Error('Inbound recovery requires journal authority')
      return this.options.inboundJournal.validateNotice(record)
    }
    if (record.covers.some((cover) => cover.store === 'background')) {
      this.options.inboundJournal?.assertAvailable()
      if (!this.options.backgroundObligations) throw new Error('Background recovery requires source authority')
      this.options.backgroundObligations.assertAvailable()
    }
    return this.options.backgroundObligations?.validateNotice(record) ?? 'open'
  }

  private async acknowledge(record: RecoveryRecord): Promise<void> {
    if (record.covers.some((cover) => cover.store === 'inbound')) {
      const journal = this.options.inboundJournal
      if (!journal) throw new Error('Inbound recovery requires journal authority')
      if (this.options.backgroundObligations)
        await this.options.backgroundObligations.withTargetLane(record.target, () => journal.acknowledgeNotice(record))
      else await journal.acknowledgeNotice(record)
      return
    }
    const source = this.options.backgroundObligations
    if (!source) return
    if (record.covers.some((cover) => cover.store === 'background')) {
      await source.withTargetLane(record.target, () => source.acknowledgeNotice(record))
    } else {
      // Legacy upgrade receipts have immutable inventory-only provenance.
      await source.acknowledgeNotice(record)
    }
  }

  /**
   * Source acknowledgment, then retirement of the terminal outbox record. Retirement requires the
   * source to validate the delivery as resolved in its lane, so no open or re-importable coverage
   * can still point at it; the outbox keeps an immutable fence for any later identical import.
   */
  private async finish(record: RecoveryRecord, retire: boolean): Promise<void> {
    await this.acknowledge(record)
    if (!retire) return
    const source = this.options.backgroundObligations
    const coverage =
      source && record.covers.some((cover) => cover.store !== 'inventory')
        ? await source.withTargetLane(record.target, () => this.validateCoverageInLane(record))
        : await this.validateCoverageInLane(record)
    if (coverage === 'resolved') await this.outbox.retire(record.deliveryId, record.generation)
  }

  async wake(): Promise<void> {
    if (this.stopped) return
    this.woken = true
    clearTimeout(this.timer)
    this.timer = undefined
    const now = this.options.now?.() ?? Date.now()
    let next = now + 30_000
    const started = new Set<string>()
    for (const record of await this.outbox.list()) {
      const key = channelKeyId(record.target)
      if (record.state === 'delivered' || record.state === 'suppressed') {
        // A lane from an earlier pass may still hold this record's in-flight send (a /stop raced
        // it), so it is retired on a later pass. A lane started by this pass skips terminal records.
        await this.finish(record, !this.lanes.has(key) || started.has(key)).catch((error) =>
          this.options.onError?.(error),
        )
        continue
      }
      const due = record.nextAttemptAt ?? 0
      if (due > now) {
        next = Math.min(next, due)
        continue
      }
      if (this.lanes.has(key)) {
        // That lane listed the outbox before this record was due or existed; run again after it.
        if (!started.has(key)) this.deferred.add(key)
        continue
      }
      started.add(key)
      const lane = this.dispatchTarget(key)
        .catch((error) => this.options.onError?.(error))
        .finally(() => {
          this.lanes.delete(key)
          if (this.deferred.delete(key)) {
            clearTimeout(this.timer)
            this.timer = undefined
            this.schedule(0)
          } else this.schedule(30_000)
        })
      this.lanes.set(key, lane)
    }
    this.schedule(Math.max(10, next - now))
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.wake().catch((error) => this.options.onError?.(error))
    }, delay)
    this.timer.unref?.()
  }
  private async acquire(record: RecoveryRecord) {
    const claim = async () => {
      if ((await this.validateCoverageInLane(record)) === 'resolved') return undefined
      if (record.lease?.epoch === this.outbox.epoch) {
        return (await this.outbox.repairLease(record.deliveryId, record.lease)) ? record.lease : undefined
      }
      return this.outbox.lease(record.deliveryId, record.generation)
    }
    try {
      const source = this.options.backgroundObligations
      return source && record.covers.some((cover) => cover.store !== 'inventory')
        ? await source.withTargetLane(record.target, claim)
        : await claim()
    } catch (error) {
      this.options.onError?.(error)
      return undefined
    }
  }

  private async dispatchTarget(key: string): Promise<void> {
    // One pass per wake avoids a blocked destination starving another record.
    for (const snapshot of await this.outbox.list()) {
      if (channelKeyId(snapshot.target) !== key || this.stopped) continue
      const record = await this.outbox.get(snapshot.deliveryId)
      const now = this.options.now?.() ?? Date.now()
      if (!record || record.state === 'delivered' || record.state === 'suppressed' || (record.nextAttemptAt ?? 0) > now)
        continue
      try {
        const source = this.options.backgroundObligations
        const coverage =
          source && record.covers.some((cover) => cover.store !== 'inventory')
            ? await source.withTargetLane(record.target, () => this.validateCoverageInLane(record!))
            : await this.validateCoverageInLane(record)
        if (coverage === 'resolved') {
          await this.outbox.suppress(record.deliveryId, 'coverage-resolved', crypto.randomUUID())
          continue
        }
        const redelivery = this.redelivery(record, now)
        if (redelivery === 'pending') continue
        if (redelivery === 'redelivered' && this.options.inboundJournal) {
          await this.suppressRedelivered(record, this.options.inboundJournal)
          continue
        }
        // Runtime state (restarts, ended turns) is never posted to channel users; the operator log
        // carries it instead. Closing the coverage keeps boot recovery from re-importing it.
        await this.suppressRecord(record, 'operator-log-only', crypto.randomUUID())
        console.log(
          `[channels] interrupted request in ${key} not re-answered (${record.cause ?? 'restart'}); no notice posted to the channel`,
        )
      } catch (error) {
        this.options.onError?.(error)
        continue
      }
    }
  }

  /** Only a never-attempted restart notice over inbound rows can be superseded by adapter redelivery. */
  private redelivery(record: RecoveryRecord, now: number): RecoveryRedelivery {
    const journal = this.options.inboundJournal
    if (!journal || record.cause !== undefined || record.attempts > 0 || !this.router.recoveryRedelivery)
      return 'not-redelivered'
    const eventKinds = journal.noticeEventKinds(record)
    if (!eventKinds) return 'not-redelivered'
    const answer = this.router.recoveryRedelivery(record, eventKinds)
    return answer === 'pending' && now - record.createdAt >= REDELIVERY_WAIT_MS ? 'not-redelivered' : answer
  }

  private async suppressRedelivered(record: RecoveryRecord, journal: InboundJournal): Promise<void> {
    const decisionId = crypto.randomUUID()
    const suppress = () => journal.suppressNoticeCoverage(record, { decisionId, reason: 'adapter-redelivered' })
    const source = this.options.backgroundObligations
    if (source) await source.withTargetLane(record.target, suppress)
    else await suppress()
    await this.outbox.suppress(record.deliveryId, 'adapter-redelivered', decisionId)
  }

  async suppressParent(target: ChannelKey, parentSessionId: string): Promise<void> {
    const parentDecisionId = crypto.randomUUID()
    for (const record of await this.outbox.list()) {
      if (channelKeyId(record.target) !== channelKeyId(target)) continue
      if (
        record.sourceParentSessionId === parentSessionId ||
        (record.covers.length > 0 && record.covers.every((coverage) => coverage.parentSessionId === parentSessionId))
      ) {
        await this.suppressRecord(record, 'user-stop', `${parentDecisionId}:${record.deliveryId}`, 'user_stop')
      }
    }
  }

  private async suppressRecord(
    record: RecoveryRecord,
    reason: string,
    decisionId: string,
    outboxReason = reason,
  ): Promise<void> {
    const source = this.options.backgroundObligations
    const suppress = async () => {
      if (record.covers.some((cover) => cover.store === 'inbound')) {
        if (!this.options.inboundJournal) throw new Error('Inbound recovery requires journal authority')
        await this.options.inboundJournal.suppressNoticeCoverage(record, { decisionId, reason })
      } else if (source) {
        if (record.covers.some((cover) => cover.store === 'background')) this.options.inboundJournal?.assertAvailable()
        await source.suppressNoticeCoverage(record, { decisionId, reason })
      }
    }
    if (source && record.covers.some((cover) => cover.store !== 'inventory'))
      await source.withTargetLane(record.target, suppress)
    else await suppress()
    await this.outbox.suppress(record.deliveryId, outboxReason, decisionId)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe()
    clearTimeout(this.timer)
    this.timer = undefined
    await Promise.all(this.lanes.values())
    await this.outbox.flush()
  }
}
