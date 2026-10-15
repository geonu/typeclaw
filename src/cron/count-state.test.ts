import { describe, expect, test } from 'bun:test'

import { type CountStoreIO, createCountStore, progressFingerprint, reconcile } from './count-state'
import type { CronJob } from './schema'

function memoryIO(): CountStoreIO & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    read: async (path) => files.get(path) ?? null,
    write: async (path, data) => {
      files.set(path, data)
    },
  }
}

const job = (id: string, extra: Partial<CronJob> = {}): CronJob =>
  ({
    id,
    schedule: '0 9 * * *',
    enabled: true,
    kind: 'prompt',
    prompt: `run ${id}`,
    count: 3,
    ...extra,
  }) as CronJob

describe('createCountStore', () => {
  test('starts a fresh job at zero', async () => {
    const store = await createCountStore('/agent', [job('a')], memoryIO())
    expect(store.get('a', job('a'))).toBe(0)
  })

  test('increment persists and is reflected in get', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)

    await store.increment('a', job('a'), Date.now())
    await store.increment('a', job('a'), Date.now())

    expect(store.get('a', job('a'))).toBe(2)
  })

  test('progress survives a reload (new store reads the persisted count)', async () => {
    const io = memoryIO()
    const first = await createCountStore('/agent', [job('a')], io)
    await first.increment('a', job('a'), Date.now())
    await first.increment('a', job('a'), Date.now())

    const second = await createCountStore('/agent', [job('a')], io)
    expect(second.get('a', job('a'))).toBe(2)
  })

  test('serializes concurrent increments without losing writes', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)

    await Promise.all([
      store.increment('a', job('a'), Date.now()),
      store.increment('a', job('a'), Date.now()),
      store.increment('a', job('a'), Date.now()),
    ])

    expect(store.get('a', job('a'))).toBe(3)
  })

  test('get returns 0 for a job whose fingerprint no longer matches the stored entry', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)
    await store.increment('a', job('a'), Date.now())

    // same id, different recurrence (changed prompt) -> stale entry must not gate it
    expect(store.get('a', job('a', { prompt: 'changed' }))).toBe(0)
    expect(store.get('a', job('a'))).toBe(1)
  })

  test('an increment that lost a reload race does not resurrect the dropped count', async () => {
    const io = memoryIO()
    const oldJob = job('a', { prompt: 'old' })
    const store = await createCountStore('/agent', [oldJob], io)
    await store.increment('a', oldJob, Date.now())
    await store.increment('a', oldJob, Date.now())

    // reload swaps the job for a different recurrence under the same id
    const newJob = job('a', { prompt: 'new' })
    await store.reconcile([newJob])

    // a straggler increment carrying the OLD fingerprint is dropped (it's no
    // longer active), so neither recurrence inherits the old count of 2
    await store.increment('a', oldJob, Date.now())
    expect(store.get('a', newJob)).toBe(0)
    expect(store.get('a', oldJob)).toBe(0)
  })

  test('a straggler increment for a removed job does not re-add a tombstone', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)

    // job removed via reload
    await store.reconcile([])

    // a fire that was already in flight when the reload landed
    await store.increment('a', job('a'), Date.now())

    // the removed job left no resurrected entry, so a later re-add starts fresh
    await store.reconcile([job('a')])
    expect(store.get('a', job('a'))).toBe(0)
  })

  test('increment queued BEFORE a synchronous reconnect-remove does not write a tombstone', async () => {
    const io = memoryIO()
    const store = await createCountStore('/agent', [job('a')], io)

    // Interleave without awaiting: queue the increment, then let reconcile([])
    // land synchronously before the increment's deferred body runs. A sync-only
    // guard would have already passed; the in-tail re-check must catch it.
    const pending = store.increment('a', job('a'), Date.now())
    void store.reconcile([])
    await pending

    await store.reconcile([job('a')])
    expect(store.get('a', job('a'))).toBe(0)
  })

  test('does not write the sidecar on boot when reconciliation is a no-op', async () => {
    const io = memoryIO()
    await createCountStore('/agent', [job('a')], io)
    expect(io.files.size).toBe(0)
  })

  test('drops malformed on-disk entries instead of trusting them', async () => {
    const io = memoryIO()
    io.files.set(
      '/agent/cron/state.json',
      JSON.stringify({
        version: 1,
        jobs: { a: { progressFingerprint: 'x', firedCount: 'lots', lastAcceptedAt: 'now' } },
      }),
    )
    const store = await createCountStore('/agent', [job('a')], io)
    expect(store.get('a', job('a'))).toBe(0)
  })
})

describe('reconcile', () => {
  test('drops state for a job id no longer present', () => {
    const state = {
      version: 1 as const,
      jobs: { gone: { progressFingerprint: 'x', firedCount: 2, lastAcceptedAt: 'now' } },
    }
    const result = reconcile(state, [job('survivor')])
    expect(result.jobs.gone).toBeUndefined()
  })

  test('drops state for a job that lost its count', () => {
    const counted = job('a')
    const state = {
      version: 1 as const,
      jobs: { a: { progressFingerprint: progressFingerprint(counted), firedCount: 2, lastAcceptedAt: 'now' } },
    }
    const result = reconcile(state, [job('a', { count: undefined })])
    expect(result.jobs.a).toBeUndefined()
  })

  test('resets progress when the recurrence fingerprint changes', () => {
    const original = job('a')
    const state = {
      version: 1 as const,
      jobs: { a: { progressFingerprint: progressFingerprint(original), firedCount: 2, lastAcceptedAt: 'now' } },
    }
    const result = reconcile(state, [job('a', { schedule: '0 18 * * *' })])
    expect(result.jobs.a).toBeUndefined()
  })

  test('preserves progress when only count changes (3 -> 5 resumes)', () => {
    const original = job('a', { count: 3 })
    const state = {
      version: 1 as const,
      jobs: { a: { progressFingerprint: progressFingerprint(original), firedCount: 3, lastAcceptedAt: 'now' } },
    }
    const result = reconcile(state, [job('a', { count: 5 })])
    expect(result.jobs.a?.firedCount).toBe(3)
  })

  test('a re-added id with a different target does NOT inherit the stale counter', () => {
    const old = job('reminder', { prompt: 'old reminder' })
    const state = {
      version: 1 as const,
      jobs: { reminder: { progressFingerprint: progressFingerprint(old), firedCount: 3, lastAcceptedAt: 'now' } },
    }
    const result = reconcile(state, [job('reminder', { prompt: 'brand new reminder' })])
    expect(result.jobs.reminder).toBeUndefined()
  })
})
