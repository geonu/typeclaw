import type {
  ChannelMessageObservedEvent,
  ChannelOutboundBeforeEvent,
  HookContext,
  Hooks,
  PluginLogger,
  SessionEndEvent,
  SessionIdleEvent,
  SessionPromptEvent,
  SessionStartEvent,
  SessionTurnEndEvent,
  SessionTurnStartEvent,
  ToolAfterEvent,
  ToolBeforeEvent,
  ToolBeforeResult,
} from './types'

// Per-handler ceiling for session.idle. The channels-side router wraps the
// whole chain at SESSION_IDLE_TIMEOUT_MS = 30s; this inner bound fires
// first so the offending plugin gets named in the logs instead of the
// chain-level timeout swallowing attribution. A handler that legitimately
// needs longer (large transcript replay, dreaming subagent) is rare — and
// `setTimeout`-driven plugins like memory-logger normally return in
// milliseconds. 25s leaves headroom under the chain watchdog.
export const IDLE_HANDLER_TIMEOUT_MS = 25_000

// Per-handler ceiling for session.end. Cron consumer's runPrompt and the
// subagent runner both await session.hooks.runSessionEnd inside their
// finally blocks — a hung handler wedges inFlight forever, so the next
// scheduler fire is silently coalesced and the cron job appears dead.
// The memory plugin's session.end awaits a serialized memory-logger chain
// that can stall on a half-open LLM stream; 60s is generous headroom for
// legitimate transcript flush while still bounding the failure mode.
export const END_HANDLER_TIMEOUT_MS = 60_000

// Per-handler ceiling for session.prompt. session.prompt fires
// synchronously inside createResourceLoader (src/agent/index.ts), which on
// channel-origin cold start is itself inside ensureLive's 30s watchdog
// (src/channels/router.ts). An unbounded hook there silently consumes the
// outer budget and times out without naming the offending plugin in the
// logs. 20s leaves ~10s of headroom for the rest of the cold-start chain
// (loadSelf, loadMemory shard reads, prefetchChannelContext) before
// ensureLive fires.
//
// The bundled memory plugin does per-turn retrieval from session.turn.start;
// this ceiling guards third-party hooks that legitimately need to do work
// inline, AND regressions that re-introduce expensive inline prompt work.
export const PROMPT_HANDLER_TIMEOUT_MS = 20_000

// Observers should enqueue and return. These bounds abandon asynchronous work;
// they cannot preempt synchronous code in a full-trust, in-process plugin.
export const OBSERVED_HANDLER_TIMEOUT_MS = 10_000
export const OUTBOUND_HANDLER_TIMEOUT_MS = 30_000

export type RegisteredHook<K extends keyof Hooks> = {
  pluginName: string
  agentDir: string
  logger: PluginLogger
  handler: NonNullable<Hooks[K]>
}

export type HookBus = {
  registerAll: (pluginName: string, agentDir: string, logger: PluginLogger, hooks: Hooks) => void
  unregisterAll: (pluginName: string) => void
  runSessionStart: (event: SessionStartEvent) => Promise<void>
  runSessionEnd: (event: SessionEndEvent) => Promise<void>
  runSessionIdle: (event: SessionIdleEvent) => Promise<void>
  runSessionPrompt: (event: SessionPromptEvent) => Promise<void>
  runSessionTurnStart: (event: SessionTurnStartEvent) => Promise<void>
  runSessionTurnEnd: (event: SessionTurnEndEvent) => Promise<void>
  runChannelMessageObserved: (event: ChannelMessageObservedEvent) => void
  runChannelOutboundBefore: (event: ChannelOutboundBeforeEvent) => Promise<{ text: string }>
  runToolBefore: (
    event: ToolBeforeEvent,
    guards?: readonly {
      owner: string
      key: string
      tools: ReadonlySet<string>
      skipOnCheckError?: true
      check: (
        event: Readonly<ToolBeforeEvent>,
      ) =>
        | undefined
        | { readonly kind: 'block' | 'acknowledgement-required'; readonly reason: string }
        | Promise<undefined | { readonly kind: 'block' | 'acknowledgement-required'; readonly reason: string }>
    }[],
    acknowledgements?: Readonly<Record<string, Readonly<Record<string, boolean>>>>,
  ) => Promise<{ block: true; reason: string } | undefined>
  runToolAfter: (event: ToolAfterEvent) => Promise<void>
  count: (name: keyof Hooks) => number
}

export type CreateHookBusOptions = {
  // Test seam: per-handler ceiling for session.idle invocations. Lets the
  // timeout path be exercised in tens of milliseconds instead of the 25s
  // production default.
  idleHandlerTimeoutMs?: number
  // Test seam: per-handler ceiling for session.end invocations.
  endHandlerTimeoutMs?: number
  // Test seam: per-handler ceiling for session.prompt invocations.
  promptHandlerTimeoutMs?: number
  observedHandlerTimeoutMs?: number
  outboundHandlerTimeoutMs?: number
}

type Registries = {
  'session.start': RegisteredHook<'session.start'>[]
  'session.end': RegisteredHook<'session.end'>[]
  'session.idle': RegisteredHook<'session.idle'>[]
  'session.prompt': RegisteredHook<'session.prompt'>[]
  'session.turn.start': RegisteredHook<'session.turn.start'>[]
  'session.turn.end': RegisteredHook<'session.turn.end'>[]
  'tool.before': Array<RegisteredHook<'tool.before'> | { pluginName: string; guardOwner: true; logger: PluginLogger }>
  'tool.after': RegisteredHook<'tool.after'>[]
  'channel.message.observed': RegisteredHook<'channel.message.observed'>[]
  'channel.outbound.before': RegisteredHook<'channel.outbound.before'>[]
}

export function createHookBus(options: CreateHookBusOptions = {}): HookBus {
  const idleHandlerTimeoutMs = options.idleHandlerTimeoutMs ?? IDLE_HANDLER_TIMEOUT_MS
  const endHandlerTimeoutMs = options.endHandlerTimeoutMs ?? END_HANDLER_TIMEOUT_MS
  const promptHandlerTimeoutMs = options.promptHandlerTimeoutMs ?? PROMPT_HANDLER_TIMEOUT_MS
  const observedHandlerTimeoutMs = options.observedHandlerTimeoutMs ?? OBSERVED_HANDLER_TIMEOUT_MS
  const outboundHandlerTimeoutMs = options.outboundHandlerTimeoutMs ?? OUTBOUND_HANDLER_TIMEOUT_MS
  const r: Registries = {
    'session.start': [],
    'session.end': [],
    'session.idle': [],
    'session.prompt': [],
    'session.turn.start': [],
    'session.turn.end': [],
    'tool.before': [],
    'tool.after': [],
    'channel.message.observed': [],
    'channel.outbound.before': [],
  }

  function ctx(reg: { pluginName: string; agentDir: string; logger: PluginLogger }): HookContext {
    return { agentDir: reg.agentDir, pluginName: reg.pluginName, logger: reg.logger }
  }

  return {
    registerAll(pluginName, agentDir, logger, hooks) {
      for (const name of Object.keys(hooks)) {
        if (!Object.hasOwn(r, name)) logger.warn(`Ignoring unknown hook "${name}" (plugin ${pluginName}).`)
      }
      const base = { pluginName, agentDir, logger }
      r['tool.before'].push({ pluginName, guardOwner: true, logger })
      if (hooks['session.start']) r['session.start'].push({ ...base, handler: hooks['session.start'] })
      if (hooks['session.end']) r['session.end'].push({ ...base, handler: hooks['session.end'] })
      if (hooks['session.idle']) r['session.idle'].push({ ...base, handler: hooks['session.idle'] })
      if (hooks['session.prompt']) r['session.prompt'].push({ ...base, handler: hooks['session.prompt'] })
      if (hooks['session.turn.start']) r['session.turn.start'].push({ ...base, handler: hooks['session.turn.start'] })
      if (hooks['session.turn.end']) r['session.turn.end'].push({ ...base, handler: hooks['session.turn.end'] })
      if (hooks['tool.before']) r['tool.before'].push({ ...base, handler: hooks['tool.before'] })
      if (hooks['tool.after']) r['tool.after'].push({ ...base, handler: hooks['tool.after'] })
      if (hooks['channel.message.observed']) {
        r['channel.message.observed'].push({ ...base, handler: hooks['channel.message.observed'] })
      }
      if (hooks['channel.outbound.before']) {
        r['channel.outbound.before'].push({ ...base, handler: hooks['channel.outbound.before'] })
      }
    },

    unregisterAll(pluginName) {
      r['session.start'] = r['session.start'].filter((h) => h.pluginName !== pluginName)
      r['session.end'] = r['session.end'].filter((h) => h.pluginName !== pluginName)
      r['session.idle'] = r['session.idle'].filter((h) => h.pluginName !== pluginName)
      r['session.prompt'] = r['session.prompt'].filter((h) => h.pluginName !== pluginName)
      r['session.turn.start'] = r['session.turn.start'].filter((h) => h.pluginName !== pluginName)
      r['session.turn.end'] = r['session.turn.end'].filter((h) => h.pluginName !== pluginName)
      r['tool.before'] = r['tool.before'].filter((h) => h.pluginName !== pluginName)
      r['tool.after'] = r['tool.after'].filter((h) => h.pluginName !== pluginName)
      r['channel.message.observed'] = r['channel.message.observed'].filter((h) => h.pluginName !== pluginName)
      r['channel.outbound.before'] = r['channel.outbound.before'].filter((h) => h.pluginName !== pluginName)
    },

    async runSessionStart(event) {
      for (const reg of r['session.start']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.start', err)
        }
      }
    },

    async runSessionEnd(event) {
      for (const reg of r['session.end']) {
        try {
          await raceWithTimeout(
            Promise.resolve(reg.handler(event, ctx(reg))),
            endHandlerTimeoutMs,
            `plugin ${reg.pluginName} session.end`,
          )
        } catch (err) {
          reportHookError(reg, 'session.end', err)
        }
      }
    },

    async runSessionIdle(event) {
      for (const reg of r['session.idle']) {
        try {
          await raceWithTimeout(
            Promise.resolve(reg.handler(event, ctx(reg))),
            idleHandlerTimeoutMs,
            `plugin ${reg.pluginName} session.idle`,
          )
        } catch (err) {
          reportHookError(reg, 'session.idle', err)
        }
      }
    },

    async runSessionPrompt(event) {
      for (const reg of r['session.prompt']) {
        try {
          await raceWithTimeout(
            Promise.resolve(reg.handler(event, ctx(reg))),
            promptHandlerTimeoutMs,
            `plugin ${reg.pluginName} session.prompt`,
          )
        } catch (err) {
          reportHookError(reg, 'session.prompt', err)
        }
      }
    },

    async runSessionTurnStart(event) {
      for (const reg of r['session.turn.start']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.turn.start', err)
        }
      }
    },

    async runSessionTurnEnd(event) {
      for (const reg of r['session.turn.end']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'session.turn.end', err)
        }
      }
    },

    // First plugin to return `{ block: true, reason }` short-circuits. Earlier
    // plugins' arg mutations remain visible to later plugins via the shared
    // event.args object.
    async runToolBefore(event, guards = [], acknowledgements) {
      for (const reg of r['tool.before']) {
        if ('guardOwner' in reg) {
          for (const guard of guards) {
            if (guard.owner !== reg.pluginName || !guard.tools.has(event.tool)) continue
            let result
            try {
              result = await guard.check(event)
            } catch (err) {
              reg.logger.error(`guard ${guard.key} threw: ${err instanceof Error ? err.message : String(err)}`)
              if (guard.skipOnCheckError) continue
              return { block: true, reason: `guard ${guard.key} failed closed after its check threw` }
            }
            if (result === undefined) continue
            if (result.kind === 'block') return { block: true, reason: result.reason }
            if (acknowledgements?.[guard.owner]?.[guard.key] !== true) {
              return { block: true, reason: result.reason }
            }
          }
          continue
        }
        let result: ToolBeforeResult
        try {
          result = await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'tool.before', err)
          continue
        }
        if (result && typeof result === 'object' && (result as { block?: unknown }).block === true) {
          const reason = (result as { reason?: unknown }).reason
          return { block: true, reason: typeof reason === 'string' ? reason : 'blocked by plugin' }
        }
      }
      return undefined
    },

    async runToolAfter(event) {
      for (const reg of r['tool.after']) {
        try {
          await reg.handler(event, ctx(reg))
        } catch (err) {
          reportHookError(reg, 'tool.after', err)
        }
      }
    },

    runChannelMessageObserved(event) {
      const regs = r['channel.message.observed']
      if (regs.length === 0) return
      let snapshot: ChannelMessageObservedEvent
      try {
        snapshot = deepFreeze(structuredClone(event))
      } catch {
        for (const reg of regs) reportChannelHookFailure(reg, 'channel.message.observed', 'snapshot failed')
        return
      }
      for (const reg of regs) {
        // Capture the registration set at receipt, even if a handler reloads it.
        queueMicrotask(() => {
          void runChannelHandler(
            reg,
            'channel.message.observed',
            () => reg.handler(snapshot, ctx(reg)),
            observedHandlerTimeoutMs,
          )
        })
      }
    },

    async runChannelOutboundBefore(event) {
      const regs = r['channel.outbound.before']
      if (regs.length === 0) return { text: event.text }
      let text = event.text
      // Capture registrations before awaiting: a reload/addition belongs to the
      // next logical delivery, not the chain currently being transformed.
      const registrations = regs.slice()
      for (const reg of registrations) {
        const snapshot = Object.freeze({
          ...event,
          text,
          ...(event.origin ? { origin: Object.freeze({ ...event.origin }) } : {}),
        })
        const result = await runChannelHandler(
          reg,
          'channel.outbound.before',
          () => reg.handler(snapshot, ctx(reg)),
          outboundHandlerTimeoutMs,
        )
        if (result === undefined) continue
        try {
          if (typeof result === 'object' && result !== null) {
            const keys = Reflect.ownKeys(result)
            if (keys.length === 1 && keys[0] === 'text') {
              const replacement = result.text
              if (typeof replacement === 'string' && replacement.trim().length > 0) {
                if (event.text.trim().length > 0) text = replacement
                continue
              }
            }
          }
        } catch {
          // Invalid accessors cannot turn a fail-open transform into a failure.
        }
        reportChannelHookFailure(reg, 'channel.outbound.before', 'invalid result')
      }
      return { text }
    },

    count(name) {
      if (name === 'tool.before') return r[name].filter((entry) => !('guardOwner' in entry)).length
      return r[name].length
    },
  }
}

function reportHookError(reg: { logger: PluginLogger }, hook: keyof Hooks, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  reg.logger.error(`hook ${hook} threw: ${message}`)
}

function reportChannelHookFailure(
  reg: { pluginName: string; logger: PluginLogger },
  hook: 'channel.message.observed' | 'channel.outbound.before',
  kind: string,
): void {
  try {
    // Rejected/thrown values may contain message bodies or credentials.
    reg.logger.error(`hook ${hook} ${kind} (plugin ${reg.pluginName})`)
  } catch {
    // Diagnostics must not break routing or fail-open delivery.
  }
}

function runChannelHandler<T>(
  reg: { pluginName: string; logger: PluginLogger },
  hook: 'channel.message.observed' | 'channel.outbound.before',
  invoke: () => T | Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value?: T, failure?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure) reportChannelHookFailure(reg, hook, failure)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined, 'timed out'), timeoutMs)
    Promise.resolve()
      .then(invoke)
      .then(
        (value) => finish(value),
        () => finish(undefined, 'failed'),
      )
  })
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  return value
}

async function raceWithTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
