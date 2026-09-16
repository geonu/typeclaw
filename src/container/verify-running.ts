import type { DockerExec } from './shared'

export type ContainerLifeStatus = 'running' | 'created' | 'restarting' | 'paused' | 'exited' | 'dead' | 'removing'

export type ContainerProbeResult =
  | { kind: 'missing' }
  | { kind: 'status'; status: ContainerLifeStatus }
  | { kind: 'daemon-error'; detail: string }

export type CrashLogs = { ok: true; text: string } | { ok: false; error: string }

export type VerifyRunningResult =
  | { ok: true }
  | { ok: false; mode: 'removed'; logs: CrashLogs }
  | { ok: false; mode: 'exited'; status: ContainerLifeStatus; logs: CrashLogs }
  | { ok: false; mode: 'daemon-error'; detail: string }

export type VerifyRunningFn = (containerName: string) => Promise<VerifyRunningResult>

export type VerifyRunningOptions = {
  exec: DockerExec
  timeoutMs?: number
  intervalMs?: number
  logsTimeoutMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

// Docker reports container State.Status as one of: created, running, paused,
// restarting, removing, exited, dead. `created`/`restarting` are transient and
// must NOT be classified as crashes — `docker run -d` returns once the daemon
// has fired off `tsk.Start()` and called State.SetRunning, but on slow hosts
// (Docker Desktop on macOS, loaded swarm nodes) the in-memory transition can
// briefly trail the API return. Treating either as a crash produces false
// positives; we keep polling until the state resolves OR the deadline hits.
const TRANSIENT_STATUSES: ReadonlySet<ContainerLifeStatus> = new Set(['created', 'restarting'])
const TERMINAL_STATUSES: ReadonlySet<ContainerLifeStatus> = new Set(['exited', 'dead', 'removing'])

// Matches the stderr Docker emits when `docker inspect <name>` finds nothing.
// Everything else — 500s, socket errors, permission denied, daemon restart —
// must surface as a daemon-error rather than be misclassified as
// "container does not exist".
const NO_SUCH_CONTAINER = /no such (?:container|object)/i

export function createVerifyRunning(options: VerifyRunningOptions): VerifyRunningFn {
  const timeoutMs = options.timeoutMs ?? 1_500
  const intervalMs = options.intervalMs ?? 100
  const logsTimeoutMs = options.logsTimeoutMs ?? 500
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  return async (containerName) => {
    if (timeoutMs <= 0) return { ok: true }
    const deadline = now() + timeoutMs
    while (now() < deadline) {
      const probe = await probeContainer(options.exec, containerName)
      if (probe.kind === 'daemon-error') {
        return { ok: false, mode: 'daemon-error', detail: probe.detail }
      }
      if (probe.kind === 'missing') {
        const logs = await captureCrashLogs(options.exec, containerName, logsTimeoutMs)
        return { ok: false, mode: 'removed', logs }
      }
      if (probe.status === 'running' || probe.status === 'paused') {
        await sleepRespectingDeadline(sleep, intervalMs, now, deadline)
        continue
      }
      if (TRANSIENT_STATUSES.has(probe.status)) {
        await sleepRespectingDeadline(sleep, intervalMs, now, deadline)
        continue
      }
      if (TERMINAL_STATUSES.has(probe.status)) {
        const logs = await captureCrashLogs(options.exec, containerName, logsTimeoutMs)
        return { ok: false, mode: 'exited', status: probe.status, logs }
      }
      await sleepRespectingDeadline(sleep, intervalMs, now, deadline)
    }
    return { ok: true }
  }
}

async function sleepRespectingDeadline(
  sleep: (ms: number) => Promise<void>,
  intervalMs: number,
  now: () => number,
  deadline: number,
): Promise<void> {
  const remaining = deadline - now()
  if (remaining <= 0) return
  await sleep(Math.min(intervalMs, remaining))
}

export async function probeContainer(exec: DockerExec, name: string): Promise<ContainerProbeResult> {
  const result = await exec(['inspect', '--format', '{{.State.Status}}', name])
  if (result.exitCode === 0) {
    const raw = result.stdout.trim().toLowerCase()
    if (isLifeStatus(raw)) return { kind: 'status', status: raw }
    return { kind: 'daemon-error', detail: `docker inspect returned unrecognized status: ${raw || '<empty>'}` }
  }
  if (NO_SUCH_CONTAINER.test(result.stderr)) return { kind: 'missing' }
  const detail = result.stderr.trim() || `docker inspect exited with code ${result.exitCode}`
  return { kind: 'daemon-error', detail }
}

export async function describeUnremovableContainer(exec: DockerExec, containerRef: string): Promise<string | null> {
  const probe = await probeContainer(exec, containerRef)
  if (probe.kind !== 'status') return null
  if (probe.status === 'removing') {
    return 'Docker is still removing this container, but the removal is not draining. docker rm, including --force, cannot re-enter an in-flight removal. Restart Docker or OrbStack; Docker will restore the container as dead, and TypeClaw can remove it on the next start or restart.'
  }
  if (probe.status === 'dead') {
    return 'Docker marked this container dead because it could not remove its filesystem. Resolve the busy mount or restart Docker, then retry.'
  }
  return null
}

function isLifeStatus(value: string): value is ContainerLifeStatus {
  return (
    value === 'running' ||
    value === 'created' ||
    value === 'restarting' ||
    value === 'paused' ||
    value === 'exited' ||
    value === 'dead' ||
    value === 'removing'
  )
}

async function captureCrashLogs(exec: DockerExec, name: string, timeoutMs: number): Promise<CrashLogs> {
  const signal = AbortSignal.timeout(timeoutMs)
  const result = await exec(['logs', '--tail', '50', name], { signal })
  const combined = `${result.stdout}${result.stderr}`.trim()
  if (result.exitCode === 0) return { ok: true, text: combined }
  if (signal.aborted) return { ok: false, error: `docker logs timed out after ${timeoutMs}ms` }
  // Docker writes container stdout/stderr to stdout/stderr respectively for
  // `docker logs`. Partial output is worth surfacing even when the command
  // ultimately fails (e.g. container removed mid-read), so we keep `combined`
  // alongside the docker-level error rather than discarding it.
  const dockerError = result.stderr.trim() || `docker logs exited with code ${result.exitCode}`
  if (combined.length > 0) return { ok: false, error: `${dockerError} (partial logs preserved)` }
  return { ok: false, error: dockerError }
}

export function buildCrashReason(name: string, failure: Extract<VerifyRunningResult, { ok: false }>): string {
  if (failure.mode === 'daemon-error') {
    return `Could not verify container ${name} stayed running: ${failure.detail}`
  }
  // We don't pass `--rm` to `docker run`, so a `removed` outcome means an
  // external process (the user, docker prune, a CI cleanup) removed the
  // container during our 1.5s verify window. Surface this distinctly from the
  // ordinary `exited` crash because the logs are gone and the user needs to
  // know why instead of chasing a phantom application bug.
  const headline =
    failure.mode === 'removed'
      ? `Container ${name} disappeared during start verification (an external process removed it).`
      : `Container ${name} stopped running immediately after start (state: ${failure.status}).`
  if (failure.logs.ok) {
    if (failure.logs.text.length === 0) return `${headline} Container produced no logs.`
    return `${headline} Last logs:\n${failure.logs.text}`
  }
  return `${headline} Could not read container logs: ${failure.logs.error}`
}
