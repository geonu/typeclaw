import { DEFAULT_SANDBOX_ENV } from './policy'

// DEFAULT_SANDBOX_ENV names are sandbox-OWNED: build.ts renders them via
// --setenv, but an inherited name skips that --setenv (inherit keeps the parent
// value), so letting `.env` PATH/HOME/BUN_* through would REPLACE the sandbox's
// safe fixed values — a PATH/loader hijack of the sandbox mechanism itself.
const RESERVED_SANDBOX_ENV_NAMES = new Set(Object.keys(DEFAULT_SANDBOX_ENV))

// Names the runtime claims for its own control plane. The token values are
// injected at container start. The model-HTTP policy values are operator-authored
// in raw-masked `.env`, but are runtime controls rather than model inputs; exposing
// them to bash would let the model discover the private network exceptions. Not a
// credential-name registry: ordinary operator credentials still belong in
// secrets.json when they must stay hidden. GH_TOKEN / GITHUB_TOKEN are NOT here:
// `.env` is the operator's expose-to-the-agent surface, so an operator who
// declares a GitHub token there has chosen to hand it to model bash (e.g. so plain
// `gh` / `git` / `curl` work in agents with no GitHub channel). The github-cli-auth
// broker still injects a narrower per-repo token via a command-scoped overlay, and
// when both exist for the same name the overlay is deduplicated and its value wins.
const RUNTIME_OWNED_ENV_NAMES = new Set<string>([
  'TYPECLAW_TUI_TOKEN',
  'TYPECLAW_HOSTD_TOKEN',
  'TYPECLAW_HOSTD_BROKER_TOKEN',
  'TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_HOSTS',
  'TYPECLAW_MODEL_HTTP_ALLOW_INTERNAL_CIDRS',
])

// Process-hijack vectors: an inherited value here changes how the shell, loader,
// or a runtime INTERPRETS later commands (arbitrary code load, config override,
// credential-socket handoff). SHELLOPTS/BASHOPTS/PS4/BASH_XTRACEFD and the
// BASH_FUNC_ prefix are OUTER-shell controls that execute in the `bash -c` that
// launches bwrap — before confinement begins (e.g. SHELLOPTS=xtrace + a
// command-substituting PS4, or an exported `BASH_FUNC_bwrap%%` replacing the
// bwrap command). These subvert the sandbox rather than expose a value.
const EXECUTION_CONTROL_ENV_NAMES = new Set<string>([
  'BASH_ENV',
  'ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'PS4',
  'BASH_XTRACEFD',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'NODE_OPTIONS',
  'BUN_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'PERL5OPT',
  'SSH_AUTH_SOCK',
  'KUBECONFIG',
])

const EXECUTION_CONTROL_ENV_PREFIXES = ['GIT_CONFIG', 'BASH_FUNC_'] as const

// Operator opt-in for values the model may type into a page but never read:
// withheld from bash, reachable only through the runtime-side
// `browser_fill_secret` tool, which types the value without returning it.
export const SECRET_ENV_PREFIX = 'TYPECLAW_SECRET_'

const GIT_IDENTITY_ENV_NAMES = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
] as const

// Withheld ONLY when the name would compromise sandbox integrity or claim a
// host/container-injected runtime token — not for being credential-shaped. `.env`
// is the operator's expose-to-the-agent surface: every value they declare there
// reaches model bash by design, INCLUDING GH_TOKEN / GITHUB_TOKEN. Credentials
// that must stay hidden belong in secrets.json.
function isWithheldEnvName(name: string): boolean {
  if (RESERVED_SANDBOX_ENV_NAMES.has(name)) return true
  if (RUNTIME_OWNED_ENV_NAMES.has(name)) return true
  if (EXECUTION_CONTROL_ENV_NAMES.has(name)) return true
  if (name.startsWith(SECRET_ENV_PREFIX)) return true
  return EXECUTION_CONTROL_ENV_PREFIXES.some((prefix) => name === prefix || name.startsWith(prefix))
}

// Every non-empty name declared in `.env`, minus sandbox-integrity/broker
// withholds, plus the four Git identity names that `typeclaw start` resolves
// from the agent repository and owns in the container environment. No other
// process.env-only name is eligible: an empty `.env` line (`X=`) remains hidden
// even if secrets.json hydration later fills process.env[X]. Inherited VALUES
// are snapshotted from process.env at spawn time.
export function resolveExposableEnvNames(
  declaredEnv: ReadonlyMap<string, string>,
  runtimeEnv: Readonly<Record<string, string | undefined>> = {},
): string[] {
  const out: string[] = []
  for (const [name, fileValue] of declaredEnv) {
    if (fileValue.length === 0) continue
    if (isWithheldEnvName(name)) continue
    out.push(name)
  }
  for (const name of GIT_IDENTITY_ENV_NAMES) {
    if (runtimeEnv[name]?.length && !out.includes(name)) out.push(name)
  }
  return out
}

// Names `browser_fill_secret` may type: everything bash already sees, plus the
// withheld `TYPECLAW_SECRET_*` tier. Runtime controls and sandbox-owned names
// stay out, so the tool can't plant a runtime token into a page for read-back.
export function resolveFillableEnvNames(
  declaredEnv: ReadonlyMap<string, string>,
  runtimeEnv: Readonly<Record<string, string | undefined>> = {},
): string[] {
  const out = resolveExposableEnvNames(declaredEnv, runtimeEnv)
  for (const [name, fileValue] of declaredEnv) {
    if (fileValue.length > 0 && name.startsWith(SECRET_ENV_PREFIX)) out.push(name)
  }
  return out
}
