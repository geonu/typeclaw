import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared/platform'

const NODE_MODULES = 'node_modules'
const TYPECLAW_DEP = 'typeclaw'

export type RunBunLink = (cwd: string) => Promise<void>

export type LinkWindowsDevTypeclawOptions = {
  platform?: NodeJS.Platform
  runBunLink?: RunBunLink
  env?: NodeJS.ProcessEnv
}

// Mirrors Bun's `openGlobalDir` env-var precedence (BUN_INSTALL_GLOBAL_DIR >
// BUN_INSTALL/install/global > XDG_CACHE_HOME/bun/install/global >
// homedir/.bun/install/global) so we resolve the same global-link location Bun
// writes to. The node_modules/<name> entry is a junction (Windows) or symlink
// (POSIX) whose target is the checkout absolute path; realpathSync resolves both.
export function resolveBunLinkedPackage(packageName: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const globalDir =
    env.BUN_INSTALL_GLOBAL_DIR ??
    (env.BUN_INSTALL ? join(env.BUN_INSTALL, 'install', 'global') : null) ??
    (env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, 'bun', 'install', 'global') : null) ??
    join(homedir(), '.bun', 'install', 'global')
  try {
    return realpathSync(join(globalDir, NODE_MODULES, packageName))
  } catch {
    return null
  }
}

// Native-Windows dev-mode only: register the typeclaw checkout via `bun link` so
// the agent can depend on it as `link:typeclaw`. `link:` resolves to a
// symlink/junction that bun's installer SKIPS entirely (no `.folder` verify,
// no uninstall-before-install, no source-tree copy) — unlike `file:`, which
// copies the whole checkout incl `.git/` and EPERMs on locked git files (the
// #899 path). Returns the linked target path (for the container bind-mount) or
// null when not Windows. POSIX keeps `file:` (registry users use a version spec
// and never reach here).
export async function linkWindowsDevTypeclaw(
  typeclawRoot: string,
  options: LinkWindowsDevTypeclawOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform
  if (!isWindows(platform)) return null
  const env = options.env ?? process.env
  const runLink = options.runBunLink ?? defaultRunBunLink
  try {
    await runLink(typeclawRoot)
  } catch (error) {
    // `bun link` is not idempotent on Windows. It deletes any existing
    // <globalDir>/node_modules/<name> entry and then creates the junction, but
    // the delete is best-effort (its error is discarded) and the pair is not
    // atomic — so a junction that resists deletion, or a second `bun link`
    // racing the first, dies on EEXIST. Re-running `typeclaw init` from a dev
    // checkout then aborts on a step that had nothing left to do. Swallow the
    // failure ONLY when the end state we wanted is already true: the global
    // entry resolves to THIS checkout. An entry pointing at a different
    // checkout, or no entry at all, still propagates, so a link that genuinely
    // failed is never mistaken for a success.
    if (!isLinkedTo(typeclawRoot, env)) throw error
  }
  return resolveBunLinkedPackage(TYPECLAW_DEP, env) ?? typeclawRoot
}

function isLinkedTo(typeclawRoot: string, env: NodeJS.ProcessEnv): boolean {
  const linked = resolveBunLinkedPackage(TYPECLAW_DEP, env)
  if (linked === null) return false
  // Both sides are realpath'd so a junction target compares equal to the
  // checkout path we were handed, and case-folded because Windows paths are
  // case-insensitive while the two resolutions need not agree on casing.
  return linked.toLowerCase() === canonicalize(typeclawRoot).toLowerCase()
}

function canonicalize(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

async function defaultRunBunLink(cwd: string): Promise<void> {
  const bun = (globalThis as { Bun?: { spawn: typeof Bun.spawn } }).Bun
  if (!bun) throw new Error('bun runtime not available to run `bun link`')
  const proc = bun.spawn({ cmd: ['bun', 'link'], cwd, stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`bun link failed in ${cwd}: ${stderr.trim() || `exited with code ${code}`}`)
  }
}
