import { defineCommand } from 'citty'

import { containerNameFromCwd, type ContainerStatus, type DockerExec, resolveController } from '@/container'
import { isDaemonReachable, send } from '@/hostd'
import type { StatusResult } from '@/hostd'
import { findAgentDir } from '@/init'
import { styled } from '@/shared'

import { type DockerPreflightResult, preflightDocker, printDockerGuidance } from './docker-preflight'

export type HostdStatus =
  | { kind: 'unreachable' }
  | { kind: 'not-registered'; reason: string }
  | { kind: 'registered'; cwd: string; forwardedPorts: number[] }

// `docker-unavailable` is not a container state — it is the absence of an
// answer. It exists so `status` can still report everything that does NOT
// depend on Docker (agent dir, container name, host daemon, forwarded ports)
// when the daemon is wedged. A diagnostic command that reports nothing at all
// because the thing it diagnoses is broken is the least useful moment to lose.
export type DockerUnavailableStatus = { kind: 'docker-unavailable'; containerName: string; summary: string }

export type StatusReport = {
  cwd: string
  container: ContainerStatus | DockerUnavailableStatus
  hostd: HostdStatus
}

export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'show the agent container and host daemon status (host stage)',
  },
  async run() {
    await runStatus()
  },
})

// Injectable seam so the render/flow can be exercised without spawning the real
// Docker CLI. The broken-config path otherwise pays a ~70s Docker Desktop
// cold-start on the first `docker info` of a Windows CI run; injecting the
// preflight + exec keeps the test on the pure flow it actually cares about.
export type RunStatusDeps = {
  cwd?: string
  preflight?: () => Promise<DockerPreflightResult>
  exec?: DockerExec
  fetchHostd?: (containerName: string) => Promise<HostdStatus>
  write?: (text: string) => void
  onDockerUnavailable?: (failure: Extract<DockerPreflightResult, { ok: false }>) => void
}

export async function runStatus(deps: RunStatusDeps = {}): Promise<void> {
  const cwd = deps.cwd ?? findAgentDir(process.cwd()) ?? process.cwd()

  const preflight = await (deps.preflight ?? preflightDocker)()
  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined
  const write = deps.write ?? ((text: string) => process.stdout.write(text))

  // Docker is unreachable: report what we can still learn without it rather
  // than dying on the guidance alone. hostd is a separate process reached over
  // its own socket, so its registration and forwarded ports stay readable — and
  // during a wedged-daemon incident that is exactly the state worth seeing.
  if (!preflight.ok) {
    const containerName = containerNameFromCwd(cwd)
    const hostd = await (deps.fetchHostd ?? fetchHostdStatus)(containerName)
    const container: DockerUnavailableStatus = {
      kind: 'docker-unavailable',
      containerName,
      summary: preflight.summary,
    }
    write(`${formatStatus({ cwd, container, hostd }, { useColor })}\n`)
    ;(deps.onDockerUnavailable ?? defaultOnDockerUnavailable)(preflight)
    return
  }

  const container = await resolveController().status({ cwd, exec: deps.exec })
  const hostd = await (deps.fetchHostd ?? fetchHostdStatus)(container.containerName)

  write(`${formatStatus({ cwd, container, hostd }, { useColor })}\n`)
}

// Sets `process.exitCode` instead of calling `process.exit()`: the degraded
// report is written immediately before this, and an immediate exit can
// terminate the process before a redirected or piped stdout has drained —
// truncating the very output this path exists to produce. Letting runStatus
// return lets the runtime flush and still exit non-zero.
function defaultOnDockerUnavailable(failure: Extract<DockerPreflightResult, { ok: false }>): void {
  printDockerGuidance(failure)
  process.exitCode = 1
}

async function fetchHostdStatus(containerName: string): Promise<HostdStatus> {
  if (!(await isDaemonReachable())) return { kind: 'unreachable' }
  const reply = await send({ kind: 'status', containerName })
  if (!reply.ok) return { kind: 'not-registered', reason: reply.reason }
  const parsed = parseStatusResult(reply.result)
  if (!parsed) return { kind: 'not-registered', reason: 'daemon returned malformed status' }
  return { kind: 'registered', cwd: parsed.cwd, forwardedPorts: parsed.forwardedPorts }
}

// Validate the daemon payload at runtime: a drift-respawn race or an older
// daemon binary can deliver a `StatusResult` without `forwardedPorts`, and the
// blind `as` cast then crashed the renderer with `undefined.length`. Defaulting
// the field to `[]` (and rejecting non-string `cwd`) keeps `typeclaw status`
// usable as a diagnostic when the daemon and CLI have drifted.
export function parseStatusResult(value: unknown): StatusResult | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.cwd !== 'string') return null
  const containerName = typeof v.containerName === 'string' ? v.containerName : ''
  const forwardedPorts = Array.isArray(v.forwardedPorts)
    ? v.forwardedPorts.filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
    : []
  return { containerName, cwd: v.cwd, forwardedPorts }
}

export type FormatOptions = { useColor?: boolean }

type ColorFn = (s: string) => string
type Palette = {
  bold: ColorFn
  dim: ColorFn
  green: ColorFn
  yellow: ColorFn
  red: ColorFn
  cyan: ColorFn
}

const identity: ColorFn = (s) => s
const NO_PALETTE: Palette = {
  bold: identity,
  dim: identity,
  green: identity,
  yellow: identity,
  red: identity,
  cyan: identity,
}

const COLOR_PALETTE: Palette = {
  bold: (s) => styled('bold', s),
  dim: (s) => styled('dim', s),
  green: (s) => styled('green', s),
  yellow: (s) => styled('yellow', s),
  red: (s) => styled('red', s),
  cyan: (s) => styled('cyan', s),
}

export function formatStatus(report: StatusReport, opts: FormatOptions = {}): string {
  const useColor = opts.useColor ?? false
  const p: Palette = useColor ? COLOR_PALETTE : NO_PALETTE

  const lines: string[] = []
  appendContainerSection(lines, report, p)
  lines.push('')
  appendHostdSection(lines, report, p)
  lines.push('')
  appendForwardingSection(lines, report, p)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

function appendContainerSection(lines: string[], report: StatusReport, p: Palette): void {
  const container = report.container
  lines.push(`${p.bold('Container')}  ${container.containerName}`)
  lines.push(row('cwd', report.cwd))

  if (container.kind === 'docker-unavailable') {
    lines.push(row('state', p.red('unknown')))
    lines.push(`  ${p.dim(container.summary)}`)
    return
  }

  lines.push(row('image', container.imageTag))

  if (container.kind === 'missing') {
    lines.push(row('state', p.dim('missing')))
    return
  }

  const stateLabel = container.kind === 'running' ? p.green('running') : p.yellow('stopped')
  lines.push(row('state', stateLabel))
  lines.push(row('id', shortId(container.containerId)))

  if (container.kind === 'running') {
    const port =
      container.hostPort === null ? p.dim('unknown') : formatHostMapping(container.hostBindAddr, container.hostPort, p)
    lines.push(row('port', port))
  }
}

function appendHostdSection(lines: string[], report: StatusReport, p: Palette): void {
  lines.push(p.bold('Host daemon'))

  switch (report.hostd.kind) {
    case 'unreachable':
      lines.push(row('state', p.dim('unreachable')))
      lines.push(`  ${p.dim('Daemon is not running. `typeclaw start` will spawn one.')}`)
      return
    case 'not-registered':
      lines.push(row('state', p.yellow('not registered')))
      lines.push(row('reason', report.hostd.reason))
      return
    case 'registered':
      lines.push(row('state', p.green('registered')))
      return
  }
}

function appendForwardingSection(lines: string[], report: StatusReport, p: Palette): void {
  lines.push(p.bold('Port forwarding'))

  if (report.hostd.kind !== 'registered') {
    lines.push(`  ${p.dim('requires the host daemon')}`)
    return
  }

  const ports = report.hostd.forwardedPorts
  if (ports.length === 0) {
    lines.push(`  ${p.dim('no ports currently forwarded')}`)
    return
  }

  for (const port of [...ports].sort((a, b) => a - b)) {
    lines.push(`  ${p.cyan(`127.0.0.1:${port}`)} ${p.dim('->')} container:${port}`)
  }
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(8)}${value}`
}

function shortId(id: string): string {
  if (id.length === 0) return '-'
  const trimmed = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
  return trimmed.slice(0, 12)
}

function formatHostMapping(bindAddr: string | null, port: number, p: Palette): string {
  const bind = bindAddr ?? '127.0.0.1'
  return `${p.cyan(`${bind}:${port}`)} ${p.dim('->')} container:${port}`
}
