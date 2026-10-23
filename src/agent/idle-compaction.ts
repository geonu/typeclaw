import { Agent, type StreamFn } from '@earendil-works/pi-agent-core'
import { AgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'

import { compactionTriggerTokens } from './compaction'

type IdleSchedule = (run: () => Promise<void>) => () => void

// Leave ten percent of the normal budget for the next input and response.
const IDLE_COMPACTION_TRIGGER_RATIO = 0.9

export function attachIdleCompaction(
  session: AgentSession,
  options: { schedule?: IdleSchedule; onApplied?: () => void; maxTriggerTokens?: number } = {},
): () => void {
  const schedule = options.schedule ?? scheduleIdle
  // Capture before turn drivers install output caps that apply only to replies.
  const stream = session.agent.streamFunction
  let cancelScheduled: (() => void) | undefined
  let pending: { cancelled: boolean; session?: AgentSession } | undefined
  let attemptedLeaf: string | null | undefined
  let disposed = false

  const cancel = () => {
    cancelScheduled?.()
    cancelScheduled = undefined
    if (pending) {
      pending.cancelled = true
      pending.session?.abortCompaction()
    }
  }

  const run = async () => {
    cancelScheduled = undefined
    const model = session.model
    const leaf = session.sessionManager.getLeafId()
    const tokens = session.getContextUsage()?.tokens
    if (
      disposed ||
      pending ||
      !session.isIdle ||
      !session.autoCompactionEnabled ||
      !model ||
      leaf === attemptedLeaf ||
      tokens == null ||
      tokens < compactionTriggerTokens(model, options.maxTriggerTokens) * IDLE_COMPACTION_TRIGGER_RATIO
    )
      return

    attemptedLeaf = leaf
    const thinkingLevel = session.thinkingLevel
    const generation: { cancelled: boolean; session?: AgentSession } = { cancelled: false }
    pending = generation
    try {
      generation.session = snapshotSession(session, stream)
      const result = await generation.session.compact()
      // No await between validation and append/refresh: the live branch cannot
      // change between the validity check and the append-only checkpoint.
      if (
        generation.cancelled ||
        disposed ||
        !session.isIdle ||
        session.model !== model ||
        session.thinkingLevel !== thinkingLevel ||
        session.sessionManager.getLeafId() !== leaf
      )
        return
      session.sessionManager.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
        false,
        result.usage,
      )
      session.refreshContext()
      options.onApplied?.()
    } catch (error) {
      // This is an optional background operation. Pi owns bounded transient
      // retries; a final failure leaves ordinary foreground compaction intact.
      if (!generation.cancelled && !disposed) {
        console.warn(
          `[agent] ${session.sessionId}: idle compaction failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    } finally {
      generation.session?.dispose()
      if (pending === generation) pending = undefined
    }
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'agent_settled') {
      cancelScheduled?.()
      // Scheduling yields past settlement so short-lived cron/subagent sessions
      // can be disposed without starting a summary they will never use.
      const tokens = session.getContextUsage()?.tokens
      const model = session.model
      if (
        model &&
        tokens != null &&
        tokens >= compactionTriggerTokens(model, options.maxTriggerTokens) * IDLE_COMPACTION_TRIGGER_RATIO
      ) {
        cancelScheduled = schedule(run)
      }
    } else if (event.type === 'agent_start' || event.type === 'compaction_start' || event.type === 'entry_appended') {
      cancel()
    }
  })

  // Cancel before prompt preflight, not just agent_start: auth and input hooks
  // may await while the provider finishes an idle summary.
  const prompt = session.prompt.bind(session)
  session.prompt = (...args) => {
    cancel()
    return prompt(...args)
  }
  const resume = session.agent.continue.bind(session.agent)
  session.agent.continue = (...args) => {
    cancel()
    return resume(...args)
  }
  const compact = session.compact.bind(session)
  session.compact = (...args) => {
    cancel()
    return compact(...args)
  }
  const dispose = session.dispose.bind(session)
  const stop = () => {
    if (disposed) return
    disposed = true
    cancel()
    unsubscribe()
    session.prompt = prompt
    session.agent.continue = resume
    session.compact = compact
    session.dispose = dispose
  }
  session.dispose = () => {
    stop()
    dispose()
  }
  return stop
}

function scheduleIdle(run: () => Promise<void>): () => void {
  const timer = setTimeout(() => void run(), 0)
  timer.unref()
  return () => clearTimeout(timer)
}

function snapshotSession(source: AgentSession, streamFn: StreamFn): AgentSession {
  const cwd = source.sessionManager.getCwd()
  // No header: pi assigns a separate session ID, preserving entry IDs for the
  // checkpoint without sharing session-scoped provider resources on disposal.
  const sessionManager = SessionManager.inMemory(cwd, undefined, structuredClone(source.sessionManager.getBranch()))
  const settingsManager = SettingsManager.inMemory({
    compaction: source.settingsManager.getCompactionSettings(source.model),
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 2_000 },
  })
  return new AgentSession({
    agent: new Agent({
      initialState: {
        model: source.model,
        thinkingLevel: source.thinkingLevel,
        messages: sessionManager.buildSessionContext().messages,
      },
      streamFn,
    }),
    sessionManager,
    settingsManager,
    modelRuntime: source.modelRuntime,
    // An unloaded loader supplies no tools or extension handlers. The shadow
    // only runs pi's built-in compact(), never a turn or extension lifecycle.
    resourceLoader: new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager }),
    cwd,
    initialActiveToolNames: [],
  })
}
