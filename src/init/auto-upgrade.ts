import { existsSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveScaffoldVersion } from './cli-version'

const PACKAGE_FILE = 'package.json'
const TYPECLAW = 'typeclaw'

// Two semver quirks drive every branch in this module:
//
// 1. Pre-1.0 caret: `^0.1.0` resolves to `>=0.1.0 <0.2.0`. A CLI bump from
//    0.1.x to 0.2.0 falls OUT of the agent's range, so we must rewrite the
//    spec for those crossings.
//
// 2. `bun install` honors the lockfile: when the lockfile entry already
//    satisfies the declared spec, `bun install` is a no-op even if a newer
//    in-range version exists upstream. To actually upgrade an in-range dep
//    we MUST use `bun update <pkg> --latest`. See src/init/run-bun-install.ts.
//
// The decision matrix anchors on the INSTALLED version (the truth), not the
// declared range floor (a promise the agent may not yet have kept).

export type AutoUpgradeOutcome =
  | { kind: 'skipped-dev-mode' }
  | { kind: 'skipped-no-dep' }
  | { kind: 'skipped-non-release-spec'; declared: string }
  | { kind: 'skipped-already-running' }
  | { kind: 'up-to-date'; installedVersion: string }
  | { kind: 'exact-pin-respected'; declared: string; cliVersion: string }
  | { kind: 'spec-rewritten'; from: string; to: string; cliVersion: string }
  | { kind: 'reinstall-needed'; from: string; to: string }
  | { kind: 'relinked-to-local'; from: string; to: string }

export type AutoUpgradeOptions = {
  cwd: string
  // Test seam: lets tests simulate dev-mode (null) and arbitrary release
  // versions without depending on the test runner's actual CLI version.
  scaffoldVersion?: string | null
  // Test seam: the local spec to relink to in dev-mode, so tests don't depend
  // on the test runner's actual checkout path.
  localSpec?: string
}

export async function autoUpgradeTypeclawDep(options: AutoUpgradeOptions): Promise<AutoUpgradeOutcome> {
  const { cwd } = options
  const scaffold = options.scaffoldVersion !== undefined ? options.scaffoldVersion : resolveScaffoldVersion()

  const pkg = await readAgentPackageJson(cwd)
  if (pkg === null) return { kind: 'skipped-no-dep' }

  const declared = pkg.parsed.dependencies?.[TYPECLAW]
  if (typeof declared !== 'string') return { kind: 'skipped-no-dep' }

  // The CLI runs from a source checkout (scaffold === null): the agent should
  // track that checkout, not a published version. Relink any registry-range
  // spec to the local spec (`file:`/`link:`); leave an exact pin (explicit user
  // override) and an already-local spec alone.
  if (scaffold === null) {
    const localSpec = options.localSpec ?? null
    if (localSpec === null || declared.startsWith('file:') || declared.startsWith('link:')) {
      return { kind: 'skipped-dev-mode' }
    }
    if (classifyDepSpec(declared).kind === 'exact') return { kind: 'skipped-dev-mode' }
    await writeDepSpec(cwd, pkg.raw, pkg.parsed, localSpec)
    return { kind: 'relinked-to-local', from: declared, to: localSpec }
  }

  const cliVersion = stripCaret(scaffold)
  if (cliVersion === null) return { kind: 'skipped-dev-mode' }

  const declaredKind = classifyDepSpec(declared)
  if (declaredKind.kind === 'non-release') {
    // An installed CLI against a local (`file:`/`link:`) spec: the agent was on
    // a dev checkout but is now run by an npm CLI — restore the registry range.
    if (declared.startsWith('file:') || declared.startsWith('link:')) {
      const newSpec = `^${cliVersion}`
      await writeDepSpec(cwd, pkg.raw, pkg.parsed, newSpec)
      return { kind: 'spec-rewritten', from: declared, to: newSpec, cliVersion }
    }
    return { kind: 'skipped-non-release-spec', declared }
  }

  const installed = readInstalledTypeclawVersion(cwd)

  // "Upgrade only, never downgrade" — anchored on the INSTALLED version
  // (the truth), with the declared range floor used ONLY when nothing is
  // installed yet (best proxy for "what would land if bun install ran").
  //
  // Anchoring on `installed` first closes the half-applied-rewrite hole:
  // a previous start may have written ^0.2.0 to package.json but failed
  // its install, leaving node_modules at 0.1.x. The declared floor would
  // wrongly say "up-to-date"; the installed version correctly says "retry."
  if (installed !== null && compareReleaseVersions(installed, cliVersion) >= 0) {
    return { kind: 'up-to-date', installedVersion: installed }
  }
  if (installed === null && declaredKind.kind !== 'exact') {
    const declaredFloor = formatTriple(declaredKind.version)
    if (compareReleaseVersions(declaredFloor, cliVersion) >= 0) {
      return { kind: 'up-to-date', installedVersion: declaredFloor }
    }
  }

  if (declaredKind.kind === 'exact') {
    const declaredVersion = formatTriple(declaredKind.version)
    // Exact pin matches CLI but installed is stale (or missing): we still
    // need to install. The user wrote the right spec — they just haven't
    // materialized it yet. Return reinstall-needed; caller will run
    // `bun update typeclaw --latest` against that exact spec.
    if (declaredVersion === cliVersion) {
      return { kind: 'reinstall-needed', from: installed ?? '<missing>', to: cliVersion }
    }
    // Exact pin diverges from CLI. User intent wins; we warn but never
    // rewrite. If installed is ALSO ahead of CLI (e.g. exact pin 0.1.5,
    // CLI 0.1.2), the up-to-date check above already returned.
    return { kind: 'exact-pin-respected', declared, cliVersion }
  }

  if (!rangeSatisfies(declaredKind, cliVersion)) {
    const newSpec = `^${cliVersion}`
    await writeDepSpec(cwd, pkg.raw, pkg.parsed, newSpec)
    return { kind: 'spec-rewritten', from: declared, to: newSpec, cliVersion }
  }

  // Declared range includes CLI. Three sub-cases:
  //   - installed === null: fresh agent, nothing on disk yet. ensureDeps
  //     will install for the missing-dep reason; nothing for us to add.
  //   - installed > CLI but in range: we already returned up-to-date above.
  //   - installed < CLI: force an upgrade via `bun update typeclaw --latest`.
  if (installed === null) {
    return { kind: 'up-to-date', installedVersion: cliVersion }
  }
  return { kind: 'reinstall-needed', from: installed, to: cliVersion }
}

export function outcomeForcesInstall(outcome: AutoUpgradeOutcome): boolean {
  return outcome.kind === 'spec-rewritten' || outcome.kind === 'reinstall-needed'
}

// A relink to a local `file:`/`link:` spec installs via a forced `bun install`
// (file deps don't "update"), NOT the `bun update --latest` path above — and it
// skips version verification, since a local install's version is whatever the
// checkout declares. start.ts ORs this into its ensureDeps force flag.
//
// Leaving a local spec for a registry range needs the same force: `bun update
// --latest` rewrites bun.lock but keeps the local copy in node_modules when its
// version already satisfies the range, so the agent would keep running the
// checkout's code.
export function outcomeRequiresForceInstall(outcome: AutoUpgradeOutcome): boolean {
  if (outcome.kind === 'relinked-to-local') return true
  return outcome.kind === 'spec-rewritten' && (outcome.from.startsWith('file:') || outcome.from.startsWith('link:'))
}

// The version we expect to find in node_modules/typeclaw after the
// auto-upgrade-triggered install completes. Callers use this to verify
// the install actually moved the on-disk version (not just resolved the
// lockfile). Returns null when no install was forced — verification is
// skipped on no-op outcomes.
export function expectedInstalledAfterUpgrade(outcome: AutoUpgradeOutcome): string | null {
  if (outcome.kind === 'spec-rewritten') return outcome.cliVersion
  if (outcome.kind === 'reinstall-needed') return outcome.to
  return null
}

export function describeAutoUpgrade(outcome: AutoUpgradeOutcome): string {
  switch (outcome.kind) {
    case 'spec-rewritten':
      return `Upgrading agent typeclaw ${outcome.from} → ${outcome.to} to match CLI`
    case 'reinstall-needed':
      return `Upgrading agent typeclaw ${outcome.from} → ${outcome.to} to match CLI`
    case 'relinked-to-local':
      return `Linking agent typeclaw to local checkout (${outcome.to})`
    case 'exact-pin-respected':
      return `Agent typeclaw is exact-pinned to ${outcome.declared}; CLI is ${outcome.cliVersion}. Not upgrading (remove the exact pin to allow auto-upgrade).`
    default:
      return ''
  }
}

export function readInstalledTypeclawVersionFromAgent(cwd: string): string | null {
  return readInstalledTypeclawVersion(cwd)
}

type ParsedPackage = {
  raw: string
  parsed: { dependencies?: Record<string, string> } & Record<string, unknown>
}

async function readAgentPackageJson(cwd: string): Promise<ParsedPackage | null> {
  const path = join(cwd, PACKAGE_FILE)
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return { raw, parsed: parsed as ParsedPackage['parsed'] }
}

function readInstalledTypeclawVersion(cwd: string): string | null {
  const path = join(cwd, 'node_modules', TYPECLAW, PACKAGE_FILE)
  if (!existsSync(path)) return null
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { version?: string }
    if (typeof parsed.version === 'string' && isReleaseVersion(parsed.version)) return parsed.version
  } catch {}
  return null
}

type DepSpecKind =
  | { kind: 'exact'; version: [number, number, number]; raw: string }
  | { kind: 'caret'; version: [number, number, number] }
  | { kind: 'tilde'; version: [number, number, number] }
  | { kind: 'non-release' }

function classifyDepSpec(spec: string): DepSpecKind {
  const trimmed = spec.trim()
  const exactMatch = trimmed.match(/^=?(\d+)\.(\d+)\.(\d+)$/)
  if (exactMatch) {
    const [, a, b, c] = exactMatch
    return { kind: 'exact', version: parseTriple(a!, b!, c!), raw: trimmed }
  }
  const caretMatch = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)$/)
  if (caretMatch) {
    const [, a, b, c] = caretMatch
    return { kind: 'caret', version: parseTriple(a!, b!, c!) }
  }
  const tildeMatch = trimmed.match(/^~(\d+)\.(\d+)\.(\d+)$/)
  if (tildeMatch) {
    const [, a, b, c] = tildeMatch
    return { kind: 'tilde', version: parseTriple(a!, b!, c!) }
  }
  return { kind: 'non-release' }
}

function parseTriple(a: string, b: string, c: string): [number, number, number] {
  return [Number.parseInt(a, 10), Number.parseInt(b, 10), Number.parseInt(c, 10)]
}

function formatTriple(v: [number, number, number]): string {
  return `${v[0]}.${v[1]}.${v[2]}`
}

// npm/bun caret+tilde semantics, narrowed to plain X.Y.Z bases:
//   ^0.1.2 → >=0.1.2 <0.2.0   (pre-1.0 caret pins minor — the bug we fix)
//   ^1.2.3 → >=1.2.3 <2.0.0
//   ~0.1.2 → >=0.1.2 <0.2.0
//   ~1.2.3 → >=1.2.3 <1.3.0
function rangeSatisfies(range: Exclude<DepSpecKind, { kind: 'exact' | 'non-release' }>, version: string): boolean {
  const v = parseVersion(version)
  if (v === null) return false
  const [base, ceiling] = rangeBounds(range)
  return compareTriples(v, base) >= 0 && compareTriples(v, ceiling) < 0
}

function rangeBounds(
  range: Exclude<DepSpecKind, { kind: 'exact' | 'non-release' }>,
): [[number, number, number], [number, number, number]] {
  const [maj, min, pat] = range.version
  if (range.kind === 'caret') {
    if (maj > 0)
      return [
        [maj, min, pat],
        [maj + 1, 0, 0],
      ]
    if (min > 0)
      return [
        [maj, min, pat],
        [maj, min + 1, 0],
      ]
    return [
      [maj, min, pat],
      [maj, min, pat + 1],
    ]
  }
  return [
    [maj, min, pat],
    [maj, min + 1, 0],
  ]
}

function parseVersion(version: string): [number, number, number] | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  const [, a, b, c] = m
  return parseTriple(a!, b!, c!)
}

function compareTriples(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const ai = a[i]!
    const bi = b[i]!
    if (ai !== bi) return ai - bi
  }
  return 0
}

function compareReleaseVersions(a: string, b: string): number {
  const av = parseVersion(a)
  const bv = parseVersion(b)
  if (av === null || bv === null) return 0
  return compareTriples(av, bv)
}

function stripCaret(scaffold: string): string | null {
  const m = scaffold.match(/^\^?(\d+\.\d+\.\d+)$/)
  return m ? (m[1] ?? null) : null
}

function isReleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version)
}

async function writeDepSpec(cwd: string, raw: string, parsed: ParsedPackage['parsed'], newSpec: string): Promise<void> {
  // Scoped edit: replace the typeclaw spec ONLY inside the dependencies
  // object. The previous implementation used `raw.replace(/"typeclaw":.../)`
  // unscoped, which would silently rewrite devDependencies.typeclaw if it
  // appeared before dependencies.typeclaw in the file (the original spec
  // never moves). We slice the dependencies object's textual range, edit
  // inside it, then splice back to preserve whitespace, key order, and
  // trailing newline. If the slice fails (unusual JSON shape), fall back
  // to a full JSON round-trip — formatting churn is acceptable; silently
  // updating the wrong key is not.
  const scoped = sliceDependenciesRange(raw, parsed)
  if (scoped !== null) {
    const { start, end } = scoped
    const block = raw.slice(start, end)
    const replaced = block.replace(
      /("typeclaw"\s*:\s*)"[^"]+"/,
      (_m, prefix: string) => `${prefix}${JSON.stringify(newSpec)}`,
    )
    if (replaced !== block) {
      await writeFile(join(cwd, PACKAGE_FILE), `${raw.slice(0, start)}${replaced}${raw.slice(end)}`)
      return
    }
  }
  const deps = { ...parsed.dependencies, [TYPECLAW]: newSpec }
  const next = { ...parsed, dependencies: deps }
  const indent = detectIndent(raw)
  await writeFile(join(cwd, PACKAGE_FILE), `${JSON.stringify(next, null, indent)}\n`)
}

// Returns the [start, end) byte range of the "dependencies" object's value
// in `raw`, or null if it can't be located unambiguously. Uses a brace-
// counting tokenizer that respects string literals so a `dependencies` key
// inside a string value (e.g. inside a `description`) cannot fool it.
function sliceDependenciesRange(raw: string, parsed: ParsedPackage['parsed']): { start: number; end: number } | null {
  if (parsed.dependencies === undefined || parsed.dependencies === null) return null
  const keyMatch = raw.match(/"dependencies"\s*:\s*\{/)
  if (!keyMatch || keyMatch.index === undefined) return null
  const startOfOpenBrace = keyMatch.index + keyMatch[0].length - 1
  const closeBrace = findMatchingCloseBrace(raw, startOfOpenBrace)
  if (closeBrace === null) return null
  return { start: startOfOpenBrace, end: closeBrace + 1 }
}

function findMatchingCloseBrace(raw: string, openIndex: number): number | null {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = openIndex; i < raw.length; i++) {
    const ch = raw[i]
    if (escape) {
      escape = false
      continue
    }
    if (inString) {
      if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return null
}

function detectIndent(raw: string): number | string {
  // Default to 2 — matches `JSON.stringify(_, _, 2)` behavior and the
  // project's existing scaffold style. Only override when we can see a
  // clear non-2 indent on the first indented line.
  const match = raw.match(/\n([\t ]+)\S/)
  if (!match) return 2
  const sample = match[1]!
  if (sample.startsWith('\t')) return '\t'
  return sample.length
}
