import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadPendingReviewStore, pendingReviewPath, type PendingReview } from './pending-review-store'

let agentDir: string
const logger = { warn: () => {} }
const entry: PendingReview = {
  repo: 'acme/widgets',
  prNumber: 7,
  prId: 700,
  kind: 'review',
  headSha: 'head-one',
  admittedAt: 100,
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), 'github-pending-'))
})

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true })
})

test('preserves pending work across reloads and canonical repo spellings', async () => {
  const store = await loadPendingReviewStore(agentDir, logger)
  await store.record(entry)
  const reloaded = await loadPendingReviewStore(agentDir, logger)
  expect(reloaded.has('ACME/Widgets', 7)).toBe(true)
  expect(await reloaded.list()).toEqual([entry])
  await reloaded.clear('ACME/Widgets', 7)
  expect(await store.list()).toEqual([])
})

test('serializes separate instances without losing unrelated admissions', async () => {
  const first = await loadPendingReviewStore(agentDir, logger)
  const second = await loadPendingReviewStore(agentDir, logger)
  await Promise.all([first.record(entry), second.record({ ...entry, prNumber: 8, prId: 800 })])
  expect(await first.list()).toHaveLength(2)
})

test('late completion and old admission cannot erase a newer head', async () => {
  const store = await loadPendingReviewStore(agentDir, logger)
  await store.record(entry)
  const newer = { ...entry, headSha: 'head-two', admittedAt: 200 }
  await store.record(newer)
  await store.clear(entry.repo, entry.prNumber, entry)
  await store.record(entry)
  expect(await store.list()).toEqual([newer])
})

test('same-head sibling admissions preserve the obligation admission time', async () => {
  const store = await loadPendingReviewStore(agentDir, logger)
  await store.record(entry)
  await store.record({ ...entry, admittedAt: 200 })
  expect(await store.list()).toEqual([entry])
})

test('ignores malformed rows and tolerates a corrupted file', async () => {
  await mkdir(join(agentDir, 'channels'))
  await writeFile(pendingReviewPath(agentDir), JSON.stringify({ version: 1, entries: [entry, {}, null] }))
  expect(await (await loadPendingReviewStore(agentDir, logger)).list()).toEqual([entry])
  await writeFile(pendingReviewPath(agentDir), '{ broken')
  const store = await loadPendingReviewStore(agentDir, logger)
  expect(await store.list()).toEqual([])
  await store.record(entry)
  expect(await (await loadPendingReviewStore(agentDir, logger)).list()).toEqual([entry])
})
