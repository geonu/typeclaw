export type LlmFetchObserverLogger = {
  info: (msg: string) => void
  warn: (msg: string) => void
}

// Per-request timeout override, attached to a RequestInit under a Symbol key so
// it travels with a single fetch() without leaking a wire header to the provider
// and without widening the endpoint matcher. Used where one call on a SHARED
// endpoint URL needs a different deadline than its siblings — e.g. GLM vision and
// GLM text hit the identical /chat/completions URL, so a URL/header match cannot
// tell them apart, but the vision caller owns its fetch and can tag it directly.
export const LLM_FETCH_OBSERVER_TIMEOUTS = Symbol.for('typeclaw.llmFetchObserverTimeouts')

export type LlmFetchObserverTimeoutOverrides = {
  ttfbMs?: number
  idleMs?: number
  overallMs?: number
}

export type LlmFetchObservedRequestInit = RequestInit & {
  [LLM_FETCH_OBSERVER_TIMEOUTS]?: LlmFetchObserverTimeoutOverrides
}

// A provider endpoint the observer should instrument. `match` is host-agnostic
// on purpose: base URLs are user-configured (ANTHROPIC_BASE_URL, OPENAI_BASE_URL,
// OpenRouter/LiteLLM/Fireworks/arbitrary proxies), so a host allowlist would be
// incomplete by design and let a stalled proxy stream slip through unguarded.
// Path-suffix matching keys off the protocol shape instead of the host.
export type LlmFetchEndpoint = {
  // Short identifier surfaced in logs as `provider=<label>` and in timeout
  // error messages, so a stall is diagnosable without provider-specific text.
  label: string
  match: (url: URL, method: string) => boolean
  // Per-endpoint timeout overrides. Unset falls back to the observer-level
  // defaults. Set to 0 to disable an individual timer for this endpoint.
  ttfbMs?: number
  idleMs?: number
  overallMs?: number
}

export type LlmFetchObserverOptions = {
  logger?: LlmFetchObserverLogger
  endpoints?: readonly LlmFetchEndpoint[]
  now?: () => number
  // Override the default pre-headers (TTFB) deadline applied to the outer
  // fetch(). When a provider silently holds a request without sending response
  // headers, this is the timer that releases the request so `pi-coding-agent`'s
  // `_isRetryableError` can retry. Default: 30_000 ms.
  //
  // Most providers return response headers within ~1s, but slow-but-healthy
  // OpenAI-compatible providers (e.g. z.ai GLM) routinely take 12-16s to send
  // headers on large prompts, so a 15s deadline aborted real requests. 30s keeps
  // a margin over that tail while still bounding a silent hang. False-positive cost is one retry (~5s extra); false-negative
  // cost is the full Bun socket deadline (~268s). Aggressive wins.
  ttfbMs?: number
  // Override the sliding inter-chunk idle deadline applied to the SSE body
  // reader. Resets on every chunk; if no bytes arrive within this window the
  // body stream errors. Doubles as a recovery bound: on a silent stall the user
  // waits this long before the retry fires, so it should not exceed the overall
  // ceiling. Default 120_000 ms. Kept uniform across providers: even though
  // Anthropic/OpenAI-compatible streams usually emit SSE pings, arbitrary proxies
  // may not, and a tighter window risks aborting a valid long reasoning pause.
  // Set to 0 to disable just this timer.
  idleMs?: number
  // Override the absolute wall-clock ceiling on a single request, measured from
  // fetch start to body completion. Unlike `idleMs`, it does NOT reset on chunk
  // arrival, so it catches a "slow-trickle" stream that emits bytes inside every
  // idle window yet never reaches a terminal SSE event. On expiry the request is
  // aborted with a retryable error, so this also bounds how long a user waits
  // before the retry fires. Default 300_000 ms: heavy reasoning turns (PR reviews,
  // memory consolidation, long channel threads) routinely trickle bytes past 2min
  // on otherwise-progressing turns, so the ceiling only needs to stop a
  // never-terminating stream. Set to 0 to disable just this timer.
  overallMs?: number
  // Schedule fn for tests. Receives (delayMs, callback) and returns a handle
  // the wrapper can pass to `clear`. Default: `setTimeout`/`clearTimeout`.
  scheduler?: TimeoutScheduler
  // Test-only: inject a pre-seeded adaptive tracker to assert widening/probe/
  // cooldown behaviour deterministically. Production always constructs its own.
  adaptiveTracker?: AdaptiveTtfbTracker
}

export type TimeoutScheduler = {
  set: (delayMs: number, cb: () => void) => unknown
  clear: (handle: unknown) => void
}

// New neutral env vars gate the whole observer and its timeouts; the Codex names
// stay as backwards-compatible aliases so existing deployments that opted out via
// TYPECLAW_CODEX_FETCH_OBSERVER=off keep that behavior.
const ENV_DISABLE_OBSERVER = 'TYPECLAW_LLM_FETCH_OBSERVER'
const ENV_DISABLE_OBSERVER_LEGACY = 'TYPECLAW_CODEX_FETCH_OBSERVER'
const ENV_DISABLE_TIMEOUTS = 'TYPECLAW_LLM_TIMEOUTS'
const ENV_DISABLE_TIMEOUTS_LEGACY = 'TYPECLAW_CODEX_TIMEOUTS'
const ENV_TTFB_MS = 'TYPECLAW_LLM_TTFB_MS'
const ENV_IDLE_MS = 'TYPECLAW_LLM_IDLE_MS'
const ENV_OVERALL_MS = 'TYPECLAW_LLM_OVERALL_MS'
// Codex keeps its own tuned overrides for the codex endpoint only.
const ENV_CODEX_TTFB_MS = 'TYPECLAW_CODEX_TTFB_MS'
const ENV_CODEX_IDLE_MS = 'TYPECLAW_CODEX_IDLE_MS'
const ENV_CODEX_OVERALL_MS = 'TYPECLAW_CODEX_OVERALL_MS'
const DEFAULT_TTFB_MS = 30_000
const DEFAULT_IDLE_MS = 120_000
const DEFAULT_OVERALL_MS = 300_000
// Codex is healthy-FAST but silently hangs: observed header latency p50~1s /
// p99~8s / max~10.8s, yet hung requests wait out the generic 30s floor. Pinning
// 13s detects hangs ~2s sooner with ~2.2s margin over the healthy max. Pinned,
// not adaptive: codex's p95 (~5.6s) never crosses the floor so widening is a
// no-op, and a longer deadline only makes each silent hang costlier to recover.
// A concrete per-endpoint `ttfbMs` also disables adaptive eligibility for codex
// (see `usesAdaptiveTtfb`). Operator-set TYPECLAW_CODEX_TTFB_MS still overrides.
const DEFAULT_CODEX_TTFB_MS = 13_000
const LOG_PREFIX = '[llm-fetch]'

// Adaptive TTFB: give a provider that is OBSERVED to be slow-but-healthy more
// pre-headers room, without blunting silent-hang detection for fast providers.
// A fixed floor kills legitimately-slow providers whose tail exceeds it; a uniform higher default would let a truly
// hung FAST provider stall for the same widened window. So widening is scoped to
// the specific origin whose recent successful header latency is actually high.
//
// Signal: rolling p95 of successful header latency (not EWMA — the distributions
// are bimodal, mostly-1s with occasional 10–16s, so a mean-tracker sits low and
// never widens for the spike). Nearest-rank p95 over the last ADAPTIVE_WINDOW_MS
// of samples reacts to the current upper tail and forgets stale slowness.
const ADAPTIVE_TTFB_FLOOR_MS = 30_000
const ADAPTIVE_TTFB_CEIL_MS = 60_000
const ADAPTIVE_TTFB_MULTIPLIER = 2
const ADAPTIVE_MIN_SAMPLES = 8
const ADAPTIVE_MAX_SAMPLES = 32
const ADAPTIVE_WINDOW_MS = 5 * 60_000
// After a timeout at the CEIL budget, the origin is treated as slow-then-hung:
// suppress all widening (learned + probe) and fail closed to the floor for this
// long, so five rapid retries can't each inherit the ceil budget. A sub-floor
// success clears the suppression early.
const ADAPTIVE_COOLDOWN_MS = 5 * 60_000

function clampMs(value: number, floor: number, ceil: number): number {
  return Math.min(ceil, Math.max(floor, value))
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil(0.95 * sorted.length)
  return sorted[Math.min(rank, sorted.length) - 1]!
}

type AdaptiveSample = { at: number; headersMs: number }

// Per-origin adaptive-TTFB state. One instance lives in the first-installed
// observer's closure and is shared across every in-flight fetch in the process
// (single-threaded event loop → plain mutable maps are safe, no locking). Keyed
// by `${label}|${origin}` so unrelated OpenAI-compatible providers/proxies never
// inherit each other's latency budget.
export class AdaptiveTtfbTracker {
  private readonly samples = new Map<string, AdaptiveSample[]>()
  // Whether the origin's next request may spend one CEIL-budget recovery probe.
  // Granted after a below-CEIL timeout (the killed request yielded only a
  // right-censored "≥floor" bound, never a usable sample — a bounded probe is
  // the only way to observe a genuinely-slow header latency past the floor).
  private readonly probeGrant = new Set<string>()
  // Origin → wall-clock time until which widening is suppressed (fail-closed).
  private readonly cooldownUntil = new Map<string, number>()

  constructor(private readonly now: () => number) {}

  // Consumes the probe grant atomically so exactly one request gets the ceil.
  resolve(key: string): number {
    if (this.isInCooldown(key)) return ADAPTIVE_TTFB_FLOOR_MS
    const learned = this.learnedTtfb(key)
    if (this.probeGrant.has(key)) {
      this.probeGrant.delete(key)
      return Math.max(learned, ADAPTIVE_TTFB_CEIL_MS)
    }
    return learned
  }

  recordHeaders(key: string, headersMs: number): void {
    // Any arrived-headers response (200/429/500) proves the origin is
    // responsive, so it's a valid latency sample and clears fail-closed state.
    if (headersMs < ADAPTIVE_TTFB_FLOOR_MS) this.cooldownUntil.delete(key)
    const list = this.samples.get(key) ?? []
    list.push({ at: this.now(), headersMs })
    this.prune(list)
    if (list.length > ADAPTIVE_MAX_SAMPLES) list.splice(0, list.length - ADAPTIVE_MAX_SAMPLES)
    this.samples.set(key, list)
  }

  // A TTFB timeout at `usedMs`. Below the ceil → grant one recovery probe.
  // At/above the ceil → the widened budget already failed; fail closed.
  recordTimeout(key: string, usedMs: number): void {
    if (usedMs >= ADAPTIVE_TTFB_CEIL_MS) {
      this.probeGrant.delete(key)
      this.cooldownUntil.set(key, this.now() + ADAPTIVE_COOLDOWN_MS)
      return
    }
    this.probeGrant.add(key)
  }

  reset(): void {
    this.samples.clear()
    this.probeGrant.clear()
    this.cooldownUntil.clear()
  }

  private learnedTtfb(key: string): number {
    const list = this.samples.get(key)
    if (list === undefined) return ADAPTIVE_TTFB_FLOOR_MS
    this.prune(list)
    if (list.length < ADAPTIVE_MIN_SAMPLES) return ADAPTIVE_TTFB_FLOOR_MS
    const target = Math.ceil(ADAPTIVE_TTFB_MULTIPLIER * p95(list.map((s) => s.headersMs)))
    return clampMs(target, ADAPTIVE_TTFB_FLOOR_MS, ADAPTIVE_TTFB_CEIL_MS)
  }

  private isInCooldown(key: string): boolean {
    const until = this.cooldownUntil.get(key)
    if (until === undefined) return false
    if (this.now() >= until) {
      this.cooldownUntil.delete(key)
      return false
    }
    return true
  }

  private prune(list: AdaptiveSample[]): void {
    const cutoff = this.now() - ADAPTIVE_WINDOW_MS
    let drop = 0
    while (drop < list.length && list[drop]!.at < cutoff) drop++
    if (drop > 0) list.splice(0, drop)
  }
}

const defaultScheduler: TimeoutScheduler = {
  set: (delayMs, cb) => setTimeout(cb, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

const consoleLogger: LlmFetchObserverLogger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
}

// Matches a path regardless of the base-URL prefix a proxy prepends (e.g.
// `/anthropic/v1/messages`). Trailing slash tolerated for proxies that append one.
function pathEndsWith(pathname: string, suffix: string): boolean {
  return pathname === suffix || pathname.endsWith(suffix) || pathname.endsWith(`${suffix}/`)
}

export function defaultLlmFetchEndpoints(env: NodeJS.ProcessEnv = process.env): readonly LlmFetchEndpoint[] {
  return [
    {
      label: 'codex',
      // Method check matches the pi-ai provider (only POST hits codex/responses);
      // GETs to the same host (auth probes, etc.) are deliberately ignored.
      match: (url, method) =>
        method === 'POST' && url.hostname === 'chatgpt.com' && url.pathname.includes('/codex/responses'),
      // TTFB is pinned to the codex-specific default (not the generic 30s) so a
      // silent hang is caught fast and adaptation is bypassed for this endpoint;
      // an operator-set TYPECLAW_CODEX_TTFB_MS still wins. Idle/overall keep the
      // fall-through shape (unset → generic TYPECLAW_LLM_* / built-in default) so
      // they aren't masked. See readEnvMsOptional and DEFAULT_CODEX_TTFB_MS.
      ttfbMs: readEnvMsOptional(env, ENV_CODEX_TTFB_MS) ?? DEFAULT_CODEX_TTFB_MS,
      idleMs: readEnvMsOptional(env, ENV_CODEX_IDLE_MS),
      overallMs: readEnvMsOptional(env, ENV_CODEX_OVERALL_MS),
    },
    {
      label: 'anthropic',
      match: (url, method) => method === 'POST' && pathEndsWith(url.pathname, '/v1/messages'),
    },
    {
      label: 'openai-compatible',
      match: (url, method) =>
        method === 'POST' &&
        (pathEndsWith(url.pathname, '/v1/chat/completions') ||
          pathEndsWith(url.pathname, '/chat/completions') ||
          pathEndsWith(url.pathname, '/v1/responses')),
    },
  ]
}

type InstallState = {
  originalFetch: typeof fetch
  wrapped: typeof fetch
  claimants: number
  adaptive: AdaptiveTtfbTracker
}

// Ref-counted so multiple agents in one process (compose, tests) share one
// `globalThis.fetch` wrapper: the FIRST install wraps fetch, each later install
// just joins, and `globalThis.fetch` is restored only when the LAST claimant
// releases. A bare singleton would let one agent's release (e.g. a second
// agent's boot-failure cleanup) tear down the observer out from under another
// still-running agent.
let installed: InstallState | null = null

// Returns the first endpoint whose matcher claims this request, or null. The
// matched endpoint's per-endpoint timeout overrides win over observer defaults.
function matchEndpoint(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  endpoints: readonly LlmFetchEndpoint[],
): { endpoint: LlmFetchEndpoint; origin: string } | null {
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  let urlString: string
  if (typeof input === 'string') urlString = input
  else if (input instanceof URL) urlString = input.toString()
  else urlString = input.url
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    return null
  }
  for (const endpoint of endpoints) {
    if (endpoint.match(parsed, method)) return { endpoint, origin: parsed.origin }
  }
  return null
}

function quote(value: string | null): string {
  if (value === null) return 'null'
  return `"${value.replace(/"/g, '\\"')}"`
}

function formatLine(fields: {
  provider: string
  // The request origin (scheme+host, no path/query — non-sensitive) that scopes
  // `seq`. `provider` alone is ambiguous: `openai-compatible` accepts arbitrary
  // proxy origins and the observer is shared across agents, so two origins can
  // each emit `provider=openai-compatible seq=1`. The origin disambiguates them
  // so seq is attributable per stream.
  origin: string
  // Per-(provider,origin) monotonic fetch sequence. A tight run of increasing seq
  // on one provider|origin is the observable signature of retry MULTIPLICATION (the
  // pi-ai codex provider's internal loop stacked under typeclaw's own retries):
  // it makes the physical-fetch count per logical turn countable from logs alone.
  // Observability only — nothing reads this back to drive behavior.
  seq: number
  status: number | null
  headersMs: number | null
  firstByteMs: number | null
  totalMs: number
  bodyBytes: number
  retryAfter: string | null
  requestId: string | null
  error: string | null
  cause: string | null
}): string {
  return [
    LOG_PREFIX,
    `provider=${fields.provider}`,
    `origin=${fields.origin}`,
    `seq=${fields.seq}`,
    `status=${fields.status === null ? 'null' : fields.status}`,
    `headers_ms=${fields.headersMs === null ? 'null' : fields.headersMs}`,
    `first_byte_ms=${fields.firstByteMs === null ? 'null' : fields.firstByteMs}`,
    `total_ms=${fields.totalMs}`,
    `body_bytes=${fields.bodyBytes}`,
    `retry_after=${fields.retryAfter === null ? 'null' : fields.retryAfter}`,
    `request_id=${fields.requestId === null ? 'null' : fields.requestId}`,
    `error=${quote(fields.error)}`,
    `cause=${fields.cause === null ? 'null' : fields.cause}`,
  ].join(' ')
}

function readEnvMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  return readEnvMsOptional(env, name) ?? fallback
}

// `undefined` when the var is unset/blank/invalid, so a per-endpoint override
// reader can fall THROUGH to the observer defaults instead of pinning a concrete
// value. This is what lets an unset `TYPECLAW_CODEX_*_MS` defer to the generic
// `TYPECLAW_LLM_*_MS` (via `envDefaults`) rather than masking it with the raw
// default — the precedence is opts > TYPECLAW_CODEX_* (when set) > TYPECLAW_LLM_*
// > built-in default.
function readEnvMsOptional(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

type ResolvedTimeouts = {
  ttfbMs: number
  idleMs: number
  overallMs: number
}

type BodyTapConfig = {
  provider: string
  origin: string
  seq: number
  idleMs: number
  overallMs: number
  scheduler: TimeoutScheduler
}

function attachBodyTimingTap(
  response: Response,
  start: number,
  headersMs: number,
  status: number,
  retryAfter: string | null,
  requestId: string | null,
  now: () => number,
  logger: LlmFetchObserverLogger,
  config: BodyTapConfig,
): Response {
  if (response.body === null) {
    logger.info(
      formatLine({
        provider: config.provider,
        origin: config.origin,
        seq: config.seq,
        status,
        headersMs,
        firstByteMs: null,
        totalMs: now() - start,
        bodyBytes: 0,
        retryAfter,
        requestId,
        error: null,
        cause: null,
      }),
    )
    return response
  }

  let firstByteMs: number | null = null
  let bodyBytes = 0
  let settled = false
  let cause: string | null = null

  const settle = (error: string | null) => {
    if (settled) return
    settled = true
    logger.info(
      formatLine({
        provider: config.provider,
        origin: config.origin,
        seq: config.seq,
        status,
        headersMs,
        firstByteMs,
        totalMs: now() - start,
        bodyBytes,
        retryAfter,
        requestId,
        error,
        cause,
      }),
    )
  }

  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (firstByteMs === null) firstByteMs = now() - start
      bodyBytes += chunk.byteLength
      controller.enqueue(chunk)
    },
    flush() {
      settle(null)
    },
  })

  const piped = response.body.pipeThrough(tap, { preventCancel: false })

  const idleController = config.idleMs > 0 || config.overallMs > 0 ? new AbortController() : null
  let idleHandle: unknown = null
  const armIdleTimer = () => {
    if (idleController === null || config.idleMs <= 0) return
    if (idleHandle !== null) config.scheduler.clear(idleHandle)
    idleHandle = config.scheduler.set(config.idleMs, () => {
      cause = 'idle_timeout'
      idleController.abort(
        new Error(`${config.provider} SSE body idle for ${config.idleMs}ms (typeclaw observer timeout)`),
      )
    })
  }

  // Absolute ceiling on the whole request, armed once and never reset. The
  // budget is measured from `start` (before originalFetch), so the time already
  // spent waiting for headers is subtracted here — otherwise a slow-headers
  // request would get a fresh full `overallMs` for its body on top of the
  // headers wait, doubling the intended ceiling. A non-positive remainder means
  // the budget is already spent, so we schedule at 0 to abort on the next tick.
  // Aborts the shared controller so the existing reader race tears the stream
  // down on the first deadline to fire — idle or overall, whichever comes first.
  let overallHandle: unknown = null
  if (idleController !== null && config.overallMs > 0) {
    const remainingOverallMs = Math.max(0, config.overallMs - (now() - start))
    overallHandle = config.scheduler.set(remainingOverallMs, () => {
      cause = 'overall_timeout'
      idleController.abort(
        new Error(
          `${config.provider} SSE body exceeded overall deadline of ${config.overallMs}ms (typeclaw observer timeout)`,
        ),
      )
    })
  }
  const disarmOverallTimer = () => {
    if (overallHandle !== null) {
      config.scheduler.clear(overallHandle)
      overallHandle = null
    }
  }

  const disarmIdleTimer = () => {
    disarmOverallTimer()
    if (idleHandle !== null) {
      config.scheduler.clear(idleHandle)
      idleHandle = null
    }
  }

  // The idle abort listener is installed exactly once for the lifetime of the
  // stream and removed in `finally`. Earlier shapes constructed a fresh
  // `Promise.race` listener per chunk; if `reader.read()` won the race, the
  // listener was never removed and closures accumulated on the signal across a
  // long stream. Keeping one shared abort promise bounds the listener count to
  // 1 regardless of chunk count.
  const observerBody = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = piped.getReader()
      armIdleTimer()
      let abortFired = false
      let onAbort: (() => void) | null = null
      const abortPromise = idleController
        ? new Promise<never>((_, reject) => {
            onAbort = () => {
              abortFired = true
              reject(idleController.signal.reason ?? new Error('idle timeout'))
            }
            if (idleController.signal.aborted) onAbort()
            else idleController.signal.addEventListener('abort', onAbort, { once: true })
          })
        : null
      // Swallow the shared rejection if no race ever observes it (clean stream
      // end before any timeout). Without this, an aborted-after-close path
      // could surface as an unhandled rejection on the runtime.
      abortPromise?.catch(() => {})
      try {
        while (true) {
          const readPromise = reader.read()
          const result = abortPromise ? await Promise.race([readPromise, abortPromise]) : await readPromise
          if (abortFired) {
            reader.cancel(idleController!.signal.reason).catch(() => {})
            throw idleController!.signal.reason
          }
          const { done, value } = result
          if (done) {
            disarmIdleTimer()
            controller.close()
            return
          }
          armIdleTimer()
          controller.enqueue(value)
        }
      } catch (err) {
        disarmIdleTimer()
        const message = err instanceof Error ? err.message : String(err)
        settle(message)
        controller.error(err)
      } finally {
        if (onAbort !== null && idleController !== null && !idleController.signal.aborted) {
          idleController.signal.removeEventListener('abort', onAbort)
        }
        reader.releaseLock()
      }
    },
    cancel(reason) {
      disarmIdleTimer()
      const message = reason === undefined ? 'cancelled' : reason instanceof Error ? reason.message : String(reason)
      settle(message)
    },
  })

  return new Response(observerBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export function installLlmFetchObserver(opts: LlmFetchObserverOptions = {}): () => void {
  if (process.env[ENV_DISABLE_OBSERVER] === 'off' || process.env[ENV_DISABLE_OBSERVER_LEGACY] === 'off') {
    return () => {}
  }
  const logger = opts.logger ?? consoleLogger
  if (installed !== null) {
    installed.claimants++
    return makeRelease(installed.wrapped)
  }

  const endpoints = opts.endpoints ?? defaultLlmFetchEndpoints()
  const now = opts.now ?? Date.now
  const scheduler = opts.scheduler ?? defaultScheduler
  const timeoutsEnabled =
    process.env[ENV_DISABLE_TIMEOUTS] !== 'off' && process.env[ENV_DISABLE_TIMEOUTS_LEGACY] !== 'off'
  const envDefaults: ResolvedTimeouts = {
    ttfbMs: readEnvMs(process.env, ENV_TTFB_MS, DEFAULT_TTFB_MS),
    idleMs: readEnvMs(process.env, ENV_IDLE_MS, DEFAULT_IDLE_MS),
    overallMs: readEnvMs(process.env, ENV_OVERALL_MS, DEFAULT_OVERALL_MS),
  }
  const originalFetch = globalThis.fetch
  const adaptive = opts.adaptiveTracker ?? new AdaptiveTtfbTracker(now)
  const fetchSeqByKey = new Map<string, number>()
  // Adaptation is a property of the built-in floor default only. Any explicit
  // static TTFB (observer opt, per-endpoint value, or a set TYPECLAW_*_TTFB_MS)
  // means the operator pinned a deadline — honour it verbatim, no widening.
  const adaptiveEligible =
    timeoutsEnabled &&
    opts.ttfbMs === undefined &&
    readEnvMsOptional(process.env, ENV_TTFB_MS) === undefined &&
    envDefaults.ttfbMs === DEFAULT_TTFB_MS

  // Precedence per timer: explicit observer-level option wins over the endpoint's
  // own value, which wins over the generic env/default. An explicit `opts.*` means
  // "force this across all endpoints" (the test seam and any global override),
  // so it must beat a per-endpoint tuned value. The master `timeoutsEnabled=off`
  // switch forces every timer to 0 regardless.
  const resolveTimeouts = (
    endpoint: LlmFetchEndpoint,
    perRequest: LlmFetchObserverTimeoutOverrides | undefined,
  ): ResolvedTimeouts => {
    if (!timeoutsEnabled) return { ttfbMs: 0, idleMs: 0, overallMs: 0 }
    return {
      ttfbMs: opts.ttfbMs ?? perRequest?.ttfbMs ?? endpoint.ttfbMs ?? envDefaults.ttfbMs,
      idleMs: opts.idleMs ?? perRequest?.idleMs ?? endpoint.idleMs ?? envDefaults.idleMs,
      overallMs: opts.overallMs ?? perRequest?.overallMs ?? endpoint.overallMs ?? envDefaults.overallMs,
    }
  }

  const wrappedImpl = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const matched = matchEndpoint(input, init, endpoints)
    if (matched === null) {
      return originalFetch(input, init)
    }
    const { endpoint, origin } = matched
    const perRequest = (init as LlmFetchObservedRequestInit | undefined)?.[LLM_FETCH_OBSERVER_TIMEOUTS]
    const timeouts = resolveTimeouts(endpoint, perRequest)
    const provider = endpoint.label
    const adaptiveKey = `${provider}|${origin}`
    const seq = (fetchSeqByKey.get(adaptiveKey) ?? 0) + 1
    fetchSeqByKey.set(adaptiveKey, seq)
    const usesAdaptiveTtfb = adaptiveEligible && perRequest?.ttfbMs === undefined && endpoint.ttfbMs === undefined
    const effectiveTtfbMs = usesAdaptiveTtfb ? adaptive.resolve(adaptiveKey) : timeouts.ttfbMs
    const start = now()

    let ttfbCause: 'ttfb_timeout' | null = null
    let ttfbHandle: unknown = null
    let initWithSignal: RequestInit | undefined = init
    if (effectiveTtfbMs > 0) {
      const ttfbController = new AbortController()
      ttfbHandle = scheduler.set(effectiveTtfbMs, () => {
        ttfbCause = 'ttfb_timeout'
        ttfbController.abort(
          new Error(
            `${provider} fetch timed out before response headers after ${effectiveTtfbMs}ms (typeclaw observer timeout)`,
          ),
        )
      })
      const signal = init?.signal ? AbortSignal.any([init.signal, ttfbController.signal]) : ttfbController.signal
      initWithSignal = { ...init, signal }
    }

    let response: Response
    try {
      response = await originalFetch(input, initWithSignal)
    } catch (err) {
      if (ttfbHandle !== null) scheduler.clear(ttfbHandle)
      const isTtfbAbort = ttfbCause === 'ttfb_timeout'
      if (isTtfbAbort && usesAdaptiveTtfb) adaptive.recordTimeout(adaptiveKey, effectiveTtfbMs)
      const surfacedError = isTtfbAbort
        ? new Error(
            `${provider} fetch timed out before response headers after ${effectiveTtfbMs}ms (typeclaw observer timeout)`,
          )
        : err
      const message = surfacedError instanceof Error ? surfacedError.message : String(surfacedError)
      logger.info(
        formatLine({
          provider,
          origin,
          seq,
          status: null,
          headersMs: null,
          firstByteMs: null,
          totalMs: now() - start,
          bodyBytes: 0,
          retryAfter: null,
          requestId: null,
          error: message,
          cause: ttfbCause,
        }),
      )
      throw surfacedError
    }
    if (ttfbHandle !== null) scheduler.clear(ttfbHandle)
    const headersMs = now() - start
    if (usesAdaptiveTtfb) adaptive.recordHeaders(adaptiveKey, headersMs)
    const retryAfter = response.headers.get('retry-after')
    const requestId = response.headers.get('x-request-id')
    return attachBodyTimingTap(response, start, headersMs, response.status, retryAfter, requestId, now, logger, {
      provider,
      origin,
      seq,
      idleMs: timeouts.idleMs,
      overallMs: timeouts.overallMs,
      scheduler,
    })
  }

  // Preserve any static methods Bun attaches to `globalThis.fetch` (e.g.
  // `preconnect`) so the wrapper is a drop-in replacement.
  const wrapped = Object.assign(wrappedImpl, {
    preconnect: (originalFetch as { preconnect?: (url: string) => void }).preconnect ?? (() => {}),
  }) as typeof fetch

  globalThis.fetch = wrapped

  installed = { originalFetch, wrapped, claimants: 1, adaptive }
  return makeRelease(wrapped)
}

// Each install call gets its own idempotent release. The shared
// `globalThis.fetch` wrapper is restored only when the final claimant releases,
// so one agent releasing never disturbs another's still-active observer.
function makeRelease(wrapped: typeof fetch): () => void {
  let released = false
  return () => {
    if (released || installed === null || installed.wrapped !== wrapped) return
    released = true
    installed.claimants--
    if (installed.claimants > 0) return
    installed.adaptive.reset()
    if (globalThis.fetch === installed.wrapped) {
      globalThis.fetch = installed.originalFetch
    }
    installed = null
  }
}
