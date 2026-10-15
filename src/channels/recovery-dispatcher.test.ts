import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RecoveryRecord } from './continuity-types'
import { InboundJournal } from './inbound-journal'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { RecoveryOutbox } from './recovery-outbox'
import type { ChannelRouter } from './router'

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>(setImmediate)
  }
  throw new Error('recovery did not reach expected durable state')
}

async function interruptedReview(dir: string) {
  const old = new InboundJournal(dir, { epoch: 'old' })
  const chat = 'pr:7'
  const admitted = await old.admit({
    accountIdentity: 'github:1',
    target: { adapter: 'github', workspace: 'acme/widgets', chat, thread: null },
    principal: { kind: 'channel', adapter: 'github', workspace: 'acme/widgets', chat, lastInboundAuthorId: 'alice' },
    messageId: 'pr-700-opened',
    eventKind: 'pull_request:opened',
    revision: '0',
  })
  await old.close()
  const journal = new InboundJournal(dir, { epoch: 'new' })
  const outbox = new RecoveryOutbox(dir, { epoch: 'new' })
  await journal.importOldEpoch(outbox)
  const [notice] = await outbox.list()
  if (!notice) throw new Error('restart notice was not imported')
  return { journal, outbox, notice, inputId: admitted.inputId }
}

test('restart and live-turn-ended notices close inbound coverage without sending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-suppression-'))
  const { journal, outbox, notice, inputId } = await interruptedReview(dir)
  const admitted = await journal.admit({
    accountIdentity: notice.accountIdentity,
    target: notice.target,
    principal: notice.principal,
    messageId: 'live-request',
    eventKind: 'message',
    revision: '0',
  })
  const live = await journal.prepareNotice(
    journal.resolve([admitted.inputId]),
    notice.target,
    [],
    undefined,
    'live-turn-ended',
  )
  await journal.importPrepared(outbox, live)
  let sends = 0
  const router = {
    setRecoveryStopHandler() {},
    send: async () => {
      sends++
      return { ok: true }
    },
  } as unknown as ChannelRouter
  const dispatcher = new RecoveryDispatcher(outbox, router, { inboundJournal: journal })
  try {
    await dispatcher.wake()
    await until(async () => (await outbox.list()).every((row) => row.state === 'suppressed'))
    await dispatcher.stop()
    for (const id of [notice.deliveryId, live.deliveryId]) {
      expect(await outbox.get(id)).toMatchObject({
        state: 'suppressed',
        suppression: { reason: 'operator-log-only' },
        attempts: 0,
      })
    }
    for (const id of [inputId, admitted.inputId]) {
      expect(journal.get(id)).toMatchObject({
        phase: 'closed',
        outcome: { kind: 'intentionally-suppressed', reason: 'operator-log-only' },
      })
    }
    expect(sends).toBe(0)
  } finally {
    await dispatcher.stop()
    await journal.close()
    await rm(dir, { recursive: true, force: true })
  }
})

function redeliveryRouter(answer: () => 'redelivered' | 'pending' | 'not-redelivered') {
  const sent: string[] = []
  const asked: string[][] = []
  const router = {
    setRecoveryStopHandler() {},
    validateRecovery: async () => undefined,
    reconcileRecovery: async () => ({ status: 'unreconcilable' }),
    recoveryRedelivery: (_record: RecoveryRecord, eventKinds: readonly string[]) => {
      asked.push([...eventKinds])
      return answer()
    },
    send: async (message: { chat: string }) => {
      sent.push(message.chat)
      return { ok: true, messageId: 'notice' }
    },
  } as unknown as ChannelRouter
  return { router, sent, asked }
}

test('a restart notice waits while the adapter decides, then yields to work the adapter re-admitted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-redelivery-'))
  const { journal, outbox, notice, inputId } = await interruptedReview(dir)
  let answer: 'redelivered' | 'pending' = 'pending'
  const { router, sent, asked } = redeliveryRouter(() => answer)
  const dispatcher = new RecoveryDispatcher(outbox, router, { inboundJournal: journal })
  try {
    // given the adapter has not yet decided whether it re-admitted the review
    await dispatcher.wake()
    await until(async () => asked.length === 1)
    // then the notice is held, untouched
    expect(asked).toEqual([['pull_request:opened']])
    expect(sent).toEqual([])
    expect((await outbox.get(notice.deliveryId))?.state).toBe('pending')

    // when the adapter reports it re-admitted the same work
    answer = 'redelivered'
    await dispatcher.wake()
    await until(async () => (await outbox.get(notice.deliveryId))?.state === 'suppressed')

    // then no notice is posted and the interrupted inbound closes as intentionally suppressed
    expect(sent).toEqual([])
    const row = journal.get(inputId)
    expect(row?.phase).toBe('closed')
    expect(row?.phase === 'closed' ? row.outcome : undefined).toMatchObject({
      kind: 'intentionally-suppressed',
      reason: 'adapter-redelivered',
    })
  } finally {
    await dispatcher.stop()
    await journal.close()
    await rm(dir, { recursive: true, force: true })
  }
})
