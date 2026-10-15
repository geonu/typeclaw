import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { noopPermissionService } from '@/permissions'

import { BackgroundObligationStore } from './background-obligations'
import { LIVE_TURN_ENDED_NOTICE_TEXT, recoveryNoticeCause } from './continuity-types'
import { RecoveryDispatcher } from './recovery-dispatcher'
import { createRecoveryNotice } from './recovery-notice'
import { RecoveryOutbox } from './recovery-outbox'
import { createChannelRouter } from './router'
import { defaultHistoryConfig } from './schema'

const target = { adapter: 'slack-bot' as const, workspace: 'team', chat: 'room', thread: null }
const liveChild = { key: target, accountIdentity: 'actor', parentSessionId: 'live', taskId: 'live' }

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>(setImmediate)
  }
  throw new Error('recovery did not reach expected durable state')
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'background-dispatch-'))
  let failAck = false
  const closed = Promise.withResolvers<void>()
  const error = Promise.withResolvers<unknown>()
  const suppressed = Promise.withResolvers<void>()
  const sent: string[] = []
  const texts: (string | undefined)[] = []
  const source = new BackgroundObligationStore(dir, {
    epoch: 'boot',
    onDurability: (phase, row) => {
      if (row.phase !== 'closed') return
      if (failAck && phase === 'temp-synced') throw new Error('source receipt write unavailable')
      if (phase === 'directory-synced') closed.resolve()
    },
  })
  const old = new BackgroundObligationStore(dir, { epoch: 'old' })
  const accepted = await old.accept({
    key: target,
    accountIdentity: 'actor',
    parentSessionId: 'parent',
    taskId: 'task',
  })
  const outbox = new RecoveryOutbox(dir, {
    epoch: 'boot',
    onDurability: (phase, row) => {
      if (phase === 'directory-synced' && row.state === 'suppressed') suppressed.resolve()
    },
  })
  await source.importOldEpoch(outbox)
  const notice = (await outbox.list())[0]!
  const router = createChannelRouter({
    agentDir: dir,
    configForAdapter: () => ({
      enabled: true,
      engagement: { trigger: ['dm'], stickiness: 'off' },
      history: defaultHistoryConfig(),
    }),
    permissions: { ...noopPermissionService, has: () => true },
    logger: { info() {}, warn() {}, error() {} },
  })
  router.registerRecoveryAdapter('slack-bot', {
    accountIdentity: async () => 'actor',
    cachedAccountIdentity: () => 'actor',
    reconcile: async () => ({ status: 'unreconcilable' }),
  })
  router.registerOutbound('slack-bot', async (message) => {
    sent.push(message.sendOptions?.accounting === 'recovery' ? message.sendOptions.deliveryId : 'unknown')
    texts.push(message.text)
    return { ok: true, messageId: 'remote-notice' }
  })
  const dispatcher = new RecoveryDispatcher(outbox, router, { backgroundObligations: source, onError: error.resolve })
  return {
    dir,
    source,
    outbox,
    notice,
    accepted,
    router,
    dispatcher,
    closed,
    suppressed,
    error,
    sent,
    texts,
    failAck: () => {
      failAck = true
    },
    cleanup: async () => {
      await dispatcher.stop()
      await router.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('operator-log-only suppression closes exactly its background source', async () => {
  const f = await fixture()
  try {
    await f.dispatcher.wake()
    await f.suppressed.promise
    await f.dispatcher.stop()
    const retirement = new RecoveryDispatcher(f.outbox, f.router, { backgroundObligations: f.source })
    try {
      await retirement.wake()
    } finally {
      await retirement.stop()
    }
    expect(f.sent).toEqual([])
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'intentionally-suppressed', reason: 'operator-log-only', deliveryId: f.notice.deliveryId },
    })
    // Acknowledged and source-resolved: the active record is retired behind its immutable fence.
    expect(await f.outbox.get(f.notice.deliveryId)).toBeUndefined()
    expect(await f.outbox.list()).toEqual([])
    expect(await f.outbox.retired(f.notice.deliveryId)).toMatchObject({
      deliveryId: f.notice.deliveryId,
      dispatch: { state: 'suppressed', suppression: { reason: 'operator-log-only' } },
    })
    expect(await f.outbox.import(f.notice)).toMatchObject({
      state: 'suppressed',
      suppression: { reason: 'operator-log-only' },
    })
    expect(await f.outbox.list()).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('failed source suppression repairs on reboot without any send', async () => {
  const f = await fixture()
  try {
    f.failAck()
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({ phase: 'notice-owned' })
    const repaired = new BackgroundObligationStore(f.dir, { epoch: 'reboot' })
    const reboot = new RecoveryDispatcher(new RecoveryOutbox(f.dir, { epoch: 'reboot' }), f.router, {
      backgroundObligations: repaired,
    })
    try {
      await reboot.wake()
      await until(async () => (await repaired.get(f.accepted.obligationId))?.phase === 'closed')
      await reboot.stop()
      expect(await repaired.get(f.accepted.obligationId)).toMatchObject({
        phase: 'closed',
        outcome: { kind: 'intentionally-suppressed', reason: 'operator-log-only' },
      })
      expect(f.sent).toEqual([])
    } finally {
      await reboot.stop()
    }
  } finally {
    await f.cleanup()
  }
})

test('forged background coverage cannot use a valid source transfer to send', async () => {
  const f = await fixture()
  try {
    await f.outbox.suppress(f.notice.deliveryId, 'test-replacement', 'replacement')
    const forged = createRecoveryNotice({
      ...f.notice,
      covers: [{ ...f.notice.covers[0]!, generation: f.notice.covers[0]!.generation + 1 }],
    })
    await f.outbox.import(forged)
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([])
    expect(await f.outbox.get(forged.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'intentionally-suppressed', decisionId: 'replacement' },
    })
  } finally {
    await f.cleanup()
  }
})

test('journal freeze blocks background but does not strand independent inventory-only notice on same target', async () => {
  const f = await fixture()
  try {
    const independent = createRecoveryNotice({
      ...f.notice,
      covers: [{ store: 'inventory', id: 'legacy', generation: 1 }],
      transferId: 'legacy',
      recoveryGeneration: 'legacy',
    })
    await f.outbox.import(independent)
    f.source.setFrozen(new Error('journal repair required'))
    await f.dispatcher.wake()
    await f.suppressed.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([])
    expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await f.outbox.get(independent.deliveryId)).toMatchObject({
      state: 'suppressed',
      suppression: { reason: 'operator-log-only' },
    })
  } finally {
    await f.cleanup()
  }
})

test('stop source suppression precedes outbox suppression and prevents dispatch', async () => {
  const f = await fixture()
  try {
    const boundary = new BackgroundObligationStore(f.dir, {
      epoch: 'boot',
      onDurability: async (phase, row) => {
        if (phase === 'directory-synced' && row.phase === 'closed') {
          expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'pending' })
        }
      },
    })
    const dispatcher = new RecoveryDispatcher(f.outbox, f.router, { backgroundObligations: boundary })
    try {
      await dispatcher.suppressParent(target, 'parent')
      await dispatcher.wake()
      await dispatcher.stop()
      expect(await boundary.get(f.accepted.obligationId)).toMatchObject({
        phase: 'closed',
        outcome: { kind: 'intentionally-suppressed', reason: 'user-stop' },
      })
      expect(await f.outbox.get(f.notice.deliveryId)).toBeUndefined()
      expect(await f.outbox.retired(f.notice.deliveryId)).toMatchObject({ dispatch: { state: 'suppressed' } })
      expect(f.sent).toEqual([])
    } finally {
      await dispatcher.stop()
    }
  } finally {
    await f.cleanup()
  }
})

test('inbound-covered notice cannot dispatch without its journal authority', async () => {
  const f = await fixture()
  try {
    await f.outbox.suppress(f.notice.deliveryId, 'test-replacement', 'replacement')
    const inbound = createRecoveryNotice({
      ...f.notice,
      covers: [{ store: 'inbound', id: 'request', generation: 1 }],
      transferId: 'inbound-transfer',
      recoveryGeneration: 'inbound-generation',
    })
    await f.outbox.import(inbound)
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    expect(f.sent).toEqual([])
    expect(await f.outbox.get(inbound.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
  } finally {
    await f.cleanup()
  }
})

test('same-epoch live-turn-ended transfer suppresses promptly with its frozen cause, then retires', async () => {
  const f = await fixture()
  try {
    // Boot: the old epoch's child closes without publishing its frozen restart notice.
    const restartSuppressed = f.suppressed.promise
    await f.dispatcher.wake()
    await restartSuppressed
    // Same process, no restart: a live turn abandons a consumed child result.
    const live = await f.source.accept(liveChild)
    const ready = (await f.source.resultReady(live.obligationId))!
    const prepared = (await f.source.withTargetLane(target, () =>
      f.source.prepareNotice(ready.obligationId, ready.generation, 'live-turn-ended'),
    ))!
    const transfer = prepared.transfer!
    expect(recoveryNoticeCause(transfer)).toBe('live-turn-ended')
    expect(transfer).toMatchObject({ schemaVersion: 2, cause: 'live-turn-ended', text: LIVE_TURN_ENDED_NOTICE_TEXT })
    expect(transfer.text).not.toContain('restart')
    // The cause is frozen at preparation; a later (default restart) prepare returns the same transfer.
    expect((await f.source.prepareNotice(prepared.obligationId, prepared.generation))!.transfer).toEqual(transfer)

    await f.source.withTargetLane(target, async () => {
      const imported = await f.outbox.import(transfer)
      await f.source.ownNotice(prepared.obligationId, prepared.generation, imported.deliveryId)
    })
    // No manual wake: the durable import itself wakes the already-booted dispatcher.
    await until(async () => (await f.outbox.get(transfer.deliveryId))?.state === 'suppressed')
    await f.dispatcher.stop()
    const retirement = new RecoveryDispatcher(f.outbox, f.router, { backgroundObligations: f.source })
    try {
      await retirement.wake()
    } finally {
      await retirement.stop()
    }
    expect(f.sent).toEqual([])
    expect(f.texts).toEqual([])
    expect(await f.source.get(live.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'intentionally-suppressed', reason: 'operator-log-only', deliveryId: transfer.deliveryId },
    })
    expect(await f.outbox.retired(transfer.deliveryId)).toMatchObject({
      dispatch: { state: 'suppressed', suppression: { reason: 'operator-log-only' } },
    })
    // Two later boots neither resend it nor turn it into a restart notice.
    for (const epoch of ['reboot-1', 'reboot-2']) {
      const store = new BackgroundObligationStore(f.dir, { epoch })
      const outbox = new RecoveryOutbox(f.dir, { epoch })
      await store.importOldEpoch(outbox)
      const dispatcher = new RecoveryDispatcher(outbox, f.router, { backgroundObligations: store })
      try {
        await dispatcher.wake()
      } finally {
        await dispatcher.stop()
      }
      expect(await outbox.list()).toEqual([])
    }
    expect(f.sent).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('live-turn-ended transfer stranded by process death is re-imported unchanged at boot, never as a restart', async () => {
  const f = await fixture()
  try {
    await f.outbox.suppress(f.notice.deliveryId, 'test-replacement', 'replacement')
    const dying = new BackgroundObligationStore(f.dir, { epoch: 'dying' })
    const live = await dying.accept(liveChild)
    const ready = (await dying.resultReady(live.obligationId))!
    // Died after freezing the live transfer, before the outbox import.
    const transfer = (await dying.prepareNotice(ready.obligationId, ready.generation, 'live-turn-ended'))!.transfer!
    const store = new BackgroundObligationStore(f.dir, { epoch: 'reboot' })
    const outbox = new RecoveryOutbox(f.dir, { epoch: 'reboot' })
    await store.importOldEpoch(outbox)
    const pending = (await outbox.list()).filter((record) => record.state === 'pending')
    expect(pending).toEqual([transfer])
    expect(recoveryNoticeCause(pending[0]!)).toBe('live-turn-ended')
    const dispatcher = new RecoveryDispatcher(outbox, f.router, { backgroundObligations: store })
    try {
      await dispatcher.wake()
      await until(async () => (await store.get(live.obligationId))?.phase === 'closed')
    } finally {
      await dispatcher.stop()
    }
    expect(f.sent).toEqual([])
    expect(f.texts).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('death after source acknowledgment but before retirement converges across reboots without a send', async () => {
  const f = await fixture()
  try {
    // The remote send and its source acknowledgment both landed; the process died before retirement.
    const lease = (await f.outbox.lease(f.notice.deliveryId, f.notice.generation))!
    await f.outbox.delivered(f.notice.deliveryId, lease, { confirmedAt: 1, messageId: 'landed-before-death' })
    const delivered = (await f.outbox.get(f.notice.deliveryId))!
    await f.source.withTargetLane(target, () => f.source.acknowledgeNotice(delivered))
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({ phase: 'closed' })
    for (const epoch of ['reboot-1', 'reboot-2']) {
      const store = new BackgroundObligationStore(f.dir, { epoch })
      const outbox = new RecoveryOutbox(f.dir, { epoch })
      await store.importOldEpoch(outbox)
      const dispatcher = new RecoveryDispatcher(outbox, f.router, { backgroundObligations: store })
      try {
        await dispatcher.wake()
      } finally {
        await dispatcher.stop()
      }
      expect(await outbox.list()).toEqual([])
      // Replaying the frozen transfer resolves to the finished delivery, never a new pending send.
      expect(await outbox.import(f.notice)).toMatchObject({
        state: 'delivered',
        receipt: { messageId: 'landed-before-death' },
      })
      expect(await outbox.lease(f.notice.deliveryId, delivered.generation)).toBeUndefined()
      expect(await outbox.list()).toEqual([])
    }
    // A different payload under the same delivery identity is rejected, not re-queued.
    await expect(f.outbox.import({ ...f.notice, transferId: 'forged-transfer' })).rejects.toThrow(
      'Conflicting recovery import',
    )
    expect((await f.outbox.listRetired()).map((fence) => fence.deliveryId)).toEqual([f.notice.deliveryId])
    expect(f.sent).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('unresolved source authority keeps a pending record active instead of retiring it', async () => {
  const f = await fixture()
  try {
    f.failAck()
    await f.dispatcher.wake()
    await f.error.promise
    await f.dispatcher.stop()
    // Source suppression failed: the pending outbox record remains the retry authority.
    expect(await f.source.get(f.accepted.obligationId)).toMatchObject({ phase: 'notice-owned' })
    expect(await f.outbox.get(f.notice.deliveryId)).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await f.outbox.retired(f.notice.deliveryId)).toBeUndefined()
    expect(f.sent).toEqual([])
  } finally {
    await f.cleanup()
  }
})

test('/stop before dispatch suppresses a live-turn-ended notice with its source and never sends it', async () => {
  const f = await fixture()
  try {
    await f.outbox.suppress(f.notice.deliveryId, 'test-replacement', 'replacement')
    const live = await f.source.accept(liveChild)
    const ready = (await f.source.resultReady(live.obligationId))!
    const prepared = (await f.source.prepareNotice(ready.obligationId, ready.generation, 'live-turn-ended'))!
    await f.outbox.import(prepared.transfer!)
    await f.source.ownNotice(prepared.obligationId, prepared.generation, prepared.transfer!.deliveryId)
    await f.dispatcher.suppressParent(target, 'live')
    await f.dispatcher.wake()
    await f.dispatcher.stop()
    expect(f.sent).toEqual([])
    expect(await f.source.get(live.obligationId)).toMatchObject({
      phase: 'closed',
      outcome: { kind: 'intentionally-suppressed', reason: 'user-stop' },
    })
    expect(await f.outbox.retired(prepared.transfer!.deliveryId)).toMatchObject({ dispatch: { state: 'suppressed' } })
  } finally {
    await f.cleanup()
  }
})
