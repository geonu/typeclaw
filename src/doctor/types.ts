export type Severity = 'ok' | 'warning' | 'error' | 'info' | 'skipped'

export type DoctorCategory =
  | 'docker'
  | 'agent-folder'
  | 'config'
  | 'mounts'
  | 'hostd'
  | 'ports'
  | 'container'
  | 'runtime'
  | 'compose'
  | string

export type FixResult = {
  summary: string
  changedPaths: string[]
}

export type FixSuggestion = {
  description: string
  autoFix?: (ctx: CheckContext) => Promise<FixResult>
}

export type CheckResult = {
  status: Severity
  message: string
  details?: string[]
  fix?: FixSuggestion
}

export type CheckContext = {
  cwd: string
  hasAgentFolder: boolean
}

export type DoctorStage = 'host' | 'container'

export type DoctorCheck = {
  name: string
  category: DoctorCategory
  description: string
  // Probes host-only state (Docker, hostd, host kernel, host paths, host-side
  // secrets). Omitted when doctor runs inside the agent container.
  hostOnly?: boolean
  applies?: (ctx: CheckContext) => boolean
  run: (ctx: CheckContext) => Promise<CheckResult>
}

export type ReportEntry = {
  name: string
  category: DoctorCategory
  description: string
  source: 'static' | 'plugin'
  pluginName?: string
  status: Severity
  message: string
  details?: string[]
  fix?: { description: string; canAutoFix: boolean }
}

export type ReportSummary = {
  ok: number
  warning: number
  error: number
  info: number
  skipped: number
}

export type DoctorReport = {
  cwd: string
  stage: DoctorStage
  hasAgentFolder: boolean
  entries: ReportEntry[]
  summary: ReportSummary
  ok: boolean
}

export type FixAttempt =
  | { name: string; source: 'static' | 'plugin'; ok: true; summary: string; changedPaths: string[] }
  | { name: string; source: 'static' | 'plugin'; ok: false; reason: string }

export type CommitOutcome =
  | { kind: 'committed'; commitSha: string; pathsStaged: string[] }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }

export type DoctorRunResult = {
  initial: DoctorReport
  fixAttempts?: FixAttempt[]
  commit?: CommitOutcome
  final?: DoctorReport
}
