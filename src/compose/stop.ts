import { type Controller, resolveController, type StopResult } from '@/container'

import { discoverAgents, type AgentEntry } from './discover'
import type { AgentResult } from './start'

export type StopSuccess = Extract<StopResult, { ok: true }>

export type ComposeStopEvent =
  | { kind: 'agent-start'; name: string }
  | { kind: 'agent-done'; name: string; result: AgentResult<StopSuccess> }

export type ComposeStopOptions = {
  rootCwd: string
  onProgress?: (event: ComposeStopEvent) => void
}

// Injectable so tests drive orchestration without real Docker. Note the
// deliberate absence of the validateConfig guard that composeStart/Restart
// have: container identity derives from cwd, not a valid typeclaw.json, so a
// corrupted config must never block cleanup or a broken config strands a
// container that can only be removed by hand.
export type ComposeStopDeps = {
  stop?: Controller['stop']
}

export type ComposeStopResult = {
  agents: AgentEntry[]
  results: AgentResult<StopSuccess>[]
}

export async function composeStop(
  { rootCwd, onProgress }: ComposeStopOptions,
  { stop = (options) => resolveController().stop(options) }: ComposeStopDeps = {},
): Promise<ComposeStopResult> {
  const agents = discoverAgents(rootCwd)
  const results = await Promise.all(
    agents.map(async (agent): Promise<AgentResult<StopSuccess>> => {
      onProgress?.({ kind: 'agent-start', name: agent.name })
      const result = await runOne(agent.name, agent.cwd, stop)
      onProgress?.({ kind: 'agent-done', name: agent.name, result })
      return result
    }),
  )
  return { agents, results }
}

async function runOne(name: string, cwd: string, stop: Controller['stop']): Promise<AgentResult<StopSuccess>> {
  const warnings: string[] = []
  try {
    const data = await stop({ cwd, onWarning: (warning) => warnings.push(warning) })
    if (!data.ok) return { name, ok: false, reason: data.reason, warnings }
    return { name, ok: true, data, warnings }
  } catch (error) {
    return { name, ok: false, reason: error instanceof Error ? error.message : String(error), warnings }
  }
}
