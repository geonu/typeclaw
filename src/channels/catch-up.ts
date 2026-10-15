import { describeError } from './describe-error'
import { readLastAlive, writeLastAlive } from './last-alive'
import type { AdapterId } from './schema'
import type { InboundMessage, RouteReceipt } from './types'

export const CHAT_CATCH_UP_MAX_AGE_MS = 15 * 60 * 1000
export const CATCH_UP_HEARTBEAT_MS = 30 * 1000
export const CATCH_UP_CONVERSATION_LIMIT = 20

export type MissedInbound = {
  readonly message: InboundMessage
  // Latest post in the source conversation, including self/system posts that
  // classification drops. Slack's reply-routing anchor is NOT this scope.
  readonly latestTs: number
}
export type ListMissedInbound = (since: number) => Promise<readonly MissedInbound[]>

export function createInboundCatchUp(options: {
  agentDir: string
  route: (message: InboundMessage) => Promise<RouteReceipt>
  logger: { info: (message: string) => void; warn: (message: string) => void }
  now?: () => number
}) {
  const now = options.now ?? Date.now
  // Admission dedup is durable in the router journal. Observation has no
  // journal row, so retain those live receipts for the chat replay window.
  const observed = new Map<string, number>()
  const observationKey = (message: InboundMessage) =>
    JSON.stringify([
      message.adapter,
      message.accountIdentity,
      message.workspace,
      message.chat,
      message.externalMessageId,
      message.authorId,
      message.eventKind,
      message.revision,
    ])
  const states = new Map<
    AdapterId,
    {
      callback: ListMissedInbound
      connected: boolean
      generation: number
      healthy: boolean
      since: Promise<number | null>
      lane: Promise<void>
    }
  >()

  const run = (adapter: AdapterId): Promise<void> => {
    const state = states.get(adapter)
    if (!state) return Promise.resolve()
    state.connected = true
    const generation = state.generation
    const active = () => states.get(adapter) === state && state.connected && state.generation === generation
    const task = state.lane.then(async () => {
      if (!active()) return
      const at = now()
      const since = (await state.since) ?? at
      const items = await state.callback(Math.max(since, at - CHAT_CATCH_UP_MAX_AGE_MS))
      for (const { message, latestTs } of items) {
        if (!active()) return
        if (message.adapter !== adapter) throw new Error('Catch-up adapter identity mismatch')
        const stale = message.ts < now() - CHAT_CATCH_UP_MAX_AGE_MS || message.ts <= 0
        const movedOn = latestTs > message.ts
        if (message.ts < since || stale || movedOn) {
          options.logger.info(
            `[channels] catch-up ${adapter} dropped id=${message.externalMessageId} reason=${movedOn ? 'moved-on' : 'stale'}`,
          )
          continue
        }
        if ((observed.get(observationKey(message)) ?? 0) > now()) continue
        // The live router owns durable admission dedup and engagement. Never
        // mark replay as an explicit mention or manufacture a wake-up.
        await options.route(message)
      }
      if (!active()) return
      await writeLastAlive(options.agentDir, adapter, at)
      state.since = Promise.resolve(at)
      state.healthy = true
    })
    state.healthy = false
    state.lane = task.catch((error: unknown) => {
      options.logger.warn(`[channels] catch-up ${adapter} failed: ${describeError(error)}`)
    })
    return state.lane
  }

  // This timer only persists liveness; it never lists history or replays chat.
  const heartbeat = setInterval(() => {
    for (const [adapter, state] of states) {
      if (!state.connected || !state.healthy) continue
      state.lane = state.lane
        .then(async () => {
          if (states.get(adapter) !== state || !state.connected || !state.healthy) return
          const at = now()
          await writeLastAlive(options.agentDir, adapter, at)
          state.since = Promise.resolve(at)
        })
        .catch((error: unknown) => {
          options.logger.warn(`[channels] catch-up heartbeat ${adapter} failed: ${describeError(error)}`)
        })
    }
  }, CATCH_UP_HEARTBEAT_MS)
  heartbeat.unref?.()

  return {
    noteObserved(message: InboundMessage): void {
      const at = now()
      for (const [key, expires] of observed) if (expires <= at) observed.delete(key)
      observed.set(observationKey(message), at + CHAT_CATCH_UP_MAX_AGE_MS)
    },
    register(adapter: AdapterId, callback: ListMissedInbound): void {
      const since = readLastAlive(options.agentDir, adapter)
      // Defer a read failure into the run's operator-only error boundary.
      void since.catch(() => undefined)
      states.set(adapter, { callback, connected: false, generation: 0, healthy: false, since, lane: Promise.resolve() })
    },
    unregister(adapter: AdapterId, callback: ListMissedInbound): void {
      if (states.get(adapter)?.callback === callback) states.delete(adapter)
    },
    disconnect(adapter: AdapterId): void {
      const state = states.get(adapter)
      if (!state) return
      state.connected = false
      state.generation++
    },
    run,
    async stop(): Promise<void> {
      clearInterval(heartbeat)
      const pending = [...states.values()].map((state) => state.lane)
      states.clear()
      await Promise.all(pending)
    },
  }
}
