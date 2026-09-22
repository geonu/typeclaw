import { resolveHostPort, resolveTuiToken, type DockerExec } from '@/container'
import type { ClientMessage, DoctorCheckPayload, DoctorFixPayload, ServerMessage } from '@/shared'

import { boundedExec } from './bounded-exec'

export type PluginBridgeOptions = {
  cwd: string
  url?: string
  timeoutMs?: number
  // Injectable so a regression test can prove the late discovery path is
  // bounded too, not just the static checks.
  exec?: DockerExec
}

export type PluginBridgeFetchChecks = (opts: PluginBridgeOptions) => Promise<PluginBridgeChecksResult>
export type PluginBridgeFetchFix = (opts: PluginBridgeOptions & { checkId: string }) => Promise<PluginBridgeFixResult>

export type PluginBridgeChecksResult =
  | { kind: 'ok'; checks: DoctorCheckPayload[] }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string }

export type PluginBridgeFixResult =
  | { kind: 'ok'; payload: DoctorFixPayload }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'timeout' }
  | { kind: 'error'; reason: string }

const DEFAULT_TIMEOUT_MS = 15_000

export async function fetchPluginDoctorChecks(opts: PluginBridgeOptions): Promise<PluginBridgeChecksResult> {
  const reach = await dial(opts)
  if (reach.kind !== 'ok') return reach
  const { ws, timeoutMs } = reach
  const requestId = randomId()
  try {
    return await withRequest<PluginBridgeChecksResult>(
      ws,
      timeoutMs,
      requestId,
      (msg) => {
        if (msg.type === 'doctor_result' && msg.requestId === requestId) {
          return { kind: 'ok', checks: msg.checks }
        }
        return null
      },
      { type: 'doctor', requestId },
    )
  } finally {
    ws.close()
  }
}

export async function fetchPluginDoctorFix(
  opts: PluginBridgeOptions & { checkId: string },
): Promise<PluginBridgeFixResult> {
  const reach = await dial(opts)
  if (reach.kind !== 'ok') return reach
  const { ws, timeoutMs } = reach
  const requestId = randomId()
  try {
    return await withRequest<PluginBridgeFixResult>(
      ws,
      timeoutMs,
      requestId,
      (msg) => {
        if (msg.type === 'doctor_fix_result' && msg.requestId === requestId) {
          return { kind: 'ok', payload: msg.result }
        }
        return null
      },
      { type: 'doctor_fix', requestId, checkId: opts.checkId },
    )
  } finally {
    ws.close()
  }
}

type DialResult = { kind: 'ok'; ws: WebSocket; timeoutMs: number } | { kind: 'unreachable'; reason: string }

async function dial(opts: PluginBridgeOptions): Promise<DialResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let url = opts.url
  if (url === undefined) {
    try {
      // Plugin discovery runs AFTER the static checks, so it is the last place
      // a wedged daemon can still hang the command: `docker port` and
      // `docker inspect` here would otherwise block with no deadline of their
      // own, long after the earlier `docker info` probes succeeded.
      // Wrap unconditionally rather than only defaulting: an injected exec is
      // no safer than the default one, and the deadline is the invariant here.
      const exec = boundedExec(opts.exec)
      const port = await resolveHostPort({ cwd: opts.cwd, exec })
      const token = await resolveTuiToken({ cwd: opts.cwd, exec })
      url = buildBridgeUrl(port, token)
    } catch (err) {
      return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
    }
  }
  const ws = new WebSocket(url)
  const displayUrl = redactUrl(url)
  try {
    await new Promise<void>((resolve, reject) => {
      // `timer` is declared up front so `cleanup` can reference it without
      // hitting the TDZ if the WS fires a synchronous error event during
      // addEventListener (theoretical, but const-after-cleanup-definition
      // would throw ReferenceError instead of being the intended no-op).
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer)
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
        ws.removeEventListener('close', onClose)
      }
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = (err: unknown) => {
        cleanup()
        reject(new Error(`failed to connect to ${displayUrl}: ${err instanceof Error ? err.message : String(err)}`))
      }
      const onClose = () => {
        cleanup()
        reject(new Error(`connection to ${displayUrl} closed before opening`))
      }
      // Bun's WebSocket has no built-in connect timeout. Without this, a TCP
      // handshake that completes but never produces an Upgrade response
      // (e.g. a wedged docker/orbstack port-forward) leaves the WS stuck in
      // CONNECTING forever — neither 'open' nor 'error' ever fires, and
      // `typeclaw doctor` hangs. The per-request timeout downstream doesn't
      // help because we never reach it.
      timer = setTimeout(() => {
        cleanup()
        try {
          ws.close()
        } catch {}
        reject(new Error(`timed out connecting to ${displayUrl} after ${timeoutMs}ms`))
      }, timeoutMs)
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError, { once: true })
      ws.addEventListener('close', onClose, { once: true })
    })
  } catch (err) {
    return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) }
  }
  return { kind: 'ok', ws, timeoutMs }
}

function buildBridgeUrl(port: number, token: string | null): string {
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '<redacted>')
    return parsed.toString()
  } catch {
    return url
  }
}

async function withRequest<R extends { kind: string }>(
  ws: WebSocket,
  timeoutMs: number,
  _requestId: string,
  match: (msg: ServerMessage) => R | null,
  outgoing: ClientMessage,
): Promise<R | { kind: 'timeout' } | { kind: 'error'; reason: string }> {
  ws.send(JSON.stringify(outgoing))
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMessage)
      resolve({ kind: 'timeout' })
    }, timeoutMs)
    const onMessage = (event: MessageEvent) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage
      } catch (err) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve({ kind: 'error', reason: err instanceof Error ? err.message : String(err) })
        return
      }
      const result = match(msg)
      if (result === null) return
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      resolve(result)
    }
    ws.addEventListener('message', onMessage)
  })
}

function randomId(): string {
  return `doc-${crypto.randomUUID()}`
}
