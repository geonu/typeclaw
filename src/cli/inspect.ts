import { defineCommand } from 'citty'

import { requireContainerRunning, resolveHostPort, resolveTuiToken } from '@/container'
import {
  fetchLiveSessions,
  listViewerItems,
  openViewerItem,
  parseDuration,
  parseFilter,
  resolveSession,
  runInspectLoop,
  runViewerLoop,
  streamLive,
  type LiveSourceFactory,
  type SelectOutcome,
  type SessionSummary,
  type ViewerItem,
} from '@/inspect'
import { originLabel, shortSessionId } from '@/inspect/label'

import { createTailScope } from './inspect-controller'
import { requireAgentDir } from './require-agent-dir'
import { cancel, c, errorLine, isCancel, prepareStdinForClack } from './ui'

const ESC_DEBOUNCE_MS = 50

export const inspectCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'session viewer: a session, the live TUI, or container logs',
  },
  args: {
    session: {
      type: 'positional',
      description: 'session id or short prefix (omit to pick from the list)',
      required: false,
    },
    filter: {
      type: 'string',
      description:
        'category filter: comma-separated meta/user/assistant/tool/error/done/broadcast/cron-fire; prefix with ! to exclude',
    },
    since: {
      type: 'string',
      description: 'only events newer than this (forms: 30s, 5m, 1h, 7d)',
    },
    json: {
      type: 'boolean',
      description: 'emit one JSON event per line; requires an explicit session id',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = requireAgentDir()
    const color = useColor()
    const sessionArg = typeof args.session === 'string' ? args.session : undefined
    const filterArg = typeof args.filter === 'string' ? args.filter : undefined
    const sinceArg = typeof args.since === 'string' ? args.since : undefined
    const isJson = args.json === true

    // JSON mode stays the scriptable, session-only path: no list, no logs/tui
    // rows, explicit session id required. Behavior is unchanged from before the
    // viewer merge.
    if (isJson) {
      const result = await runInspectLoop({
        agentDir: cwd,
        ...(sessionArg !== undefined ? { sessionIdOrPrefix: sessionArg } : {}),
        ...(filterArg !== undefined ? { filter: filterArg } : {}),
        ...(sinceArg !== undefined ? { since: sinceArg } : {}),
        json: true,
        color,
        selectSession: (sessions, selectOpts) => clackSelectSession(sessions, selectOpts?.initialSessionId),
        createTailScope: () => createTailScope({ debounceMs: ESC_DEBOUNCE_MS }),
        stdout: (line) => process.stdout.write(`${line}\n`),
        stderr: (line) => process.stderr.write(`${line}\n`),
      })
      finish(result)
      return
    }

    const exitCode = await runInspectViewer({
      cwd,
      ...(sessionArg !== undefined ? { sessionArg } : {}),
      ...(filterArg !== undefined ? { filterArg } : {}),
      ...(sinceArg !== undefined ? { sinceArg } : {}),
      color,
    })
    process.exit(exitCode)
  },
})

export type RunInspectViewerOptions = {
  cwd: string
  sessionArg?: string
  filterArg?: string
  sinceArg?: string
  color?: boolean
  // Set false by the `tui` detach handoff: the live session was just ended, so
  // no row should be offered as writable (see listViewerItems).
  allowWritable?: boolean
}

// The interactive session-viewer: list → open → back to list. Shared by the
// `inspect` command and `tui`'s esc-detach fallthrough. Returns an exit code
// instead of calling process.exit so callers can chain (e.g. tui drops here).
export async function runInspectViewer(opts: RunInspectViewerOptions): Promise<number> {
  const { cwd } = opts
  const color = opts.color ?? useColor()

  const filterResult = parseFilter(opts.filterArg)
  if (!filterResult.ok) {
    process.stderr.write(`${errorLine(filterResult.reason)}\n`)
    return 2
  }
  let sinceMs: number | undefined
  if (opts.sinceArg !== undefined) {
    const d = parseDuration(opts.sinceArg)
    if (!d.ok) {
      process.stderr.write(`${errorLine(d.reason)}\n`)
      return 2
    }
    sinceMs = Date.now() - d.ms
  }

  const interactive = Boolean(process.stdin.isTTY)
  // Reject picker-only invocations before probing Docker: no container state
  // can make a non-interactive terminal capable of driving the picker.
  if (!interactive && opts.sessionArg === undefined) {
    process.stderr.write(`${errorLine('typeclaw inspect needs an interactive terminal to pick a session.')}\n`)
    process.stderr.write(
      'Pass an explicit session id (`typeclaw inspect <id>`) or use `--json <id>` for a scriptable stream.\n',
    )
    return 2
  }

  const containerRunning = (await requireContainerRunning({ cwd })).ok
  if (!containerRunning) {
    process.stderr.write(`${c.yellow('⚠')} container not running; showing read-only history and logs only\n`)
  }

  const sessionsDir = `${cwd}/sessions`

  // Resolve a session arg (id or short prefix) to a full session id BEFORE the
  // loop: runViewerLoop matches preselectKey against exact itemKeys, so a bare
  // prefix would otherwise miss every row and report "no sessions". 'logs' is a
  // reserved key, not a session, so it bypasses resolution.
  let preselectKey: string | undefined
  if (opts.sessionArg !== undefined && opts.sessionArg !== 'logs') {
    const resolved = await resolveSession(sessionsDir, opts.sessionArg, (l) => process.stderr.write(`${l}\n`))
    if (!resolved.ok) {
      const reason =
        resolved.reason === 'ambiguous'
          ? `Ambiguous session prefix "${opts.sessionArg}" matches ${resolved.matches.length} sessions. Use a longer prefix or run \`typeclaw inspect\` without args.`
          : `No session matching "${opts.sessionArg}" in ${sessionsDir}/`
      process.stderr.write(`${errorLine(reason)}\n`)
      return resolved.reason === 'ambiguous' ? 2 : 1
    }
    preselectKey = resolved.summary.sessionId
  } else if (opts.sessionArg === 'logs') {
    preselectKey = 'logs'
  }

  const liveHint = interactive ? escHintLine(color) : undefined
  const inspectUrl = containerRunning ? await resolveInspectUrl(cwd) : undefined
  const liveSource = inspectUrl !== undefined ? buildLiveSource(inspectUrl) : undefined

  const stdout = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const stderr = (line: string): void => {
    process.stderr.write(`${line}\n`)
  }

  const open = openViewerItem({
    cwd,
    filter: filterResult.filter,
    sinceMs,
    json: false,
    color,
    interactive,
    stdout,
    stderr,
    resolveTuiUrl: () => resolveTuiUrl(cwd),
    ...(liveSource !== undefined ? { liveSource } : {}),
    ...(liveHint !== undefined ? { liveHint } : {}),
  })

  const cliAllowWritable = opts.allowWritable !== false
  const result = await runViewerLoop<ViewerItem>({
    listItems: async ({ allowWritable: loopAllowWritable }) => {
      const listOpts: Parameters<typeof listViewerItems>[0] = {
        sessionsDir,
        containerRunning,
        // listViewerItems also gates writable promotion on `interactive`, so a
        // non-TTY explicit id can't auto-open a TUI it cannot drive.
        interactive,
        // Compose the CLI-level permission (false on tui detach handoff) with
        // the loop-level one (false after returning to the picker from a viewer).
        allowWritable: cliAllowWritable && loopAllowWritable,
        limit: 20,
        onWarn: stderr,
      }
      if (sinceMs !== undefined) listOpts.sinceMs = sinceMs
      if (inspectUrl !== undefined) listOpts.liveSessions = await fetchLiveSessions({ url: inspectUrl })
      return (await listViewerItems(listOpts)).items
    },
    keyOf: (item) => (item.kind === 'logs' ? 'logs' : item.summary.sessionId),
    ...(preselectKey !== undefined ? { preselectKey } : {}),
    selectItem: (items, selectOpts) => clackSelectItem(items, selectOpts.initialKey),
    openItem: open,
    createTailScope: () => createTailScope({ debounceMs: ESC_DEBOUNCE_MS }),
    onEmpty: () => ({
      ok: false,
      exitCode: 1,
      reason: `No sessions found in ${sessionsDir}/.\nStart a session with \`typeclaw tui\` or send a message from a configured channel.`,
    }),
  })

  if (!result.ok && result.reason !== undefined) {
    process.stderr.write(`${errorLine(result.reason)}\n`)
  }
  return result.exitCode
}

function finish(result: { ok: boolean; exitCode: number; reason?: string }): void {
  if (!result.ok && result.reason !== undefined) {
    process.stderr.write(`${errorLine(result.reason)}\n`)
  }
  process.exit(result.exitCode)
}

async function resolveTuiUrl(cwd: string): Promise<string> {
  const precheck = await requireContainerRunning({ cwd })
  if (!precheck.ok) throw new Error(precheck.reason)
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  const url = new URL(`ws://127.0.0.1:${port}`)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}

async function resolveInspectUrl(cwd: string): Promise<string> {
  const port = await resolveHostPort({ cwd })
  const token = await resolveTuiToken({ cwd })
  const baseUrl = new URL(`ws://127.0.0.1:${port}/inspect`)
  if (token !== null) baseUrl.searchParams.set('token', token)
  return baseUrl.toString()
}

function buildLiveSource(url: string): LiveSourceFactory {
  return ({ sessionId, sinceMs, signal, onSubscribed }) =>
    streamLive({
      url,
      sessionId,
      ...(sinceMs !== undefined ? { sinceMs } : {}),
      ...(signal !== undefined ? { signal } : {}),
      ...(onSubscribed !== undefined ? { onSubscribed } : {}),
    })
}

function escHintLine(color: boolean): string {
  const text = '(esc to return to the list · q to quit)'
  return color ? `\u001b[2m${text}\u001b[0m` : text
}

function useColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  if (process.env.FORCE_COLOR === '0') return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
}

async function clackSelectItem(
  items: ViewerItem[],
  initialKey: string | undefined,
): Promise<SelectOutcome<ViewerItem>> {
  const { refreshableSelect } = await import('./inspect-select')
  prepareStdinForClack()
  const keyOf = (item: ViewerItem): string => (item.kind === 'logs' ? 'logs' : item.summary.sessionId)
  const preferred =
    initialKey !== undefined && items.some((i) => keyOf(i) === initialKey) ? initialKey : keyOf(items[0]!)
  const outcome = await refreshableSelect<string>({
    message: `Pick what to view (showing ${items.length}) ${c.dim('· r to refresh')}`,
    options: items.map((item) => ({
      value: keyOf(item),
      label: itemLabel(item),
      ...itemHint(item),
    })),
    initialValue: preferred,
  })
  if (outcome.kind === 'cancelled') {
    cancel('Cancelled.')
    return { kind: 'cancelled' }
  }
  if (outcome.kind === 'refresh') {
    return { kind: 'refresh', highlightKey: outcome.highlightValue }
  }
  const chosen = items.find((i) => keyOf(i) === outcome.value)
  return chosen !== undefined ? { kind: 'picked', item: chosen } : { kind: 'cancelled' }
}

async function clackSelectSession(
  sessions: SessionSummary[],
  initialSessionId: string | undefined,
): Promise<SessionSummary | null> {
  const { select } = await import('@clack/prompts')
  prepareStdinForClack()
  const preferred =
    initialSessionId !== undefined && sessions.some((s) => s.sessionId === initialSessionId)
      ? initialSessionId
      : sessions[0]?.sessionId
  const picked = await select<string>({
    message: `Pick a session to inspect (showing ${sessions.length})`,
    options: sessions.map((s) => ({
      value: s.sessionId,
      label: sessionRowLabel(s),
      ...(s.firstPrompt !== null ? { hint: truncate(s.firstPrompt, 60) } : { hint: '(no prompt)' }),
    })),
    initialValue: preferred,
  })
  if (isCancel(picked)) {
    cancel('Cancelled.')
    return null
  }
  return sessions.find((s) => s.sessionId === picked) ?? null
}

function itemLabel(item: ViewerItem): string {
  // clack's select already draws a radio dot (●/○) per option; a leading status
  // dot here doubled it into a confusing "● ○". Keep rows glyph-free; the live
  // row uses ▸ (not a dot) to stay distinct from the radio cursor.
  if (item.kind === 'logs') return `${c.dim('▤')} container logs`
  if (item.kind === 'tui') return `${c.green('▸')} ${c.bold('live TUI')}  ${sessionRowLabel(item.summary)}`
  return sessionRowLabel(item.summary)
}

function itemHint(item: ViewerItem): { hint: string } {
  if (item.kind === 'logs') return { hint: 'read-only · works offline' }
  if (item.kind === 'tui') return { hint: 'read+write · esc detaches and ends the live session' }
  if (item.summary.firstPrompt !== null) return { hint: truncate(item.summary.firstPrompt, 60) }
  return { hint: '(no prompt)' }
}

export function sessionRowLabel(s: SessionSummary): string {
  const id = shortSessionId(s.sessionId)
  const label = s.origin === null ? '(unknown origin)' : originLabel(s.origin)
  const when = s.live === true ? c.green('live') : c.dim(formatRelative(s.mtimeMs))
  return `${c.cyan(id)}  ${label}  ${when}`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function truncate(text: string, max: number): string {
  const oneline = text.replace(/\s+/g, ' ').trim()
  if (oneline.length <= max) return oneline
  return `${oneline.slice(0, max)}…`
}
