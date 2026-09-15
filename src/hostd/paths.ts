import { createHash } from 'node:crypto'
import { chmod, mkdir } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

import { isWindows } from '@/shared'

const SOCKET_FILE = 'hostd.sock'
const REGISTRATIONS_DIR = 'registrations'
const KEYS_DIR = 'keys'
const AGENT_OPERATION_LOCKS_DIR = 'agent-locks'

// Defense-in-depth: containerName arrives from RPC payloads (some of which
// originate inside the container). Docker already forbids slashes and most
// punctuation in names, but we don't want to trust the wire to enforce that.
// The character class mirrors Docker's container-naming rules; anything
// else is rejected so a malicious payload can't escape registrationsDir().
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

export function homeRoot(): string {
  const override = process.env.TYPECLAW_HOME
  if (override && override.length > 0) return override
  return join(homedir(), '.typeclaw')
}

export function runDir(): string {
  return join(homeRoot(), 'run')
}

export function logDir(): string {
  return join(homeRoot(), 'log')
}

export function socketPath(): string {
  if (isWindows()) return windowsPipePath()
  return join(runDir(), SOCKET_FILE)
}

function windowsPipePath(): string {
  const uid =
    typeof process.getuid === 'function'
      ? `uid:${process.getuid()}`
      : `user:${process.env.USERDOMAIN ?? ''}\\${userInfo().username}`
  // Locale-invariant lowercasing: toLocaleLowerCase under e.g. tr-TR would map
  // 'I' to a dotless 'ı', hashing the same path differently per process locale.
  const scopedHome = resolve(homeRoot()).toLowerCase()
  const hash = createHash('sha256').update(`${uid}\0${scopedHome}`).digest('hex').slice(0, 32)

  // Node's net named-pipe API has no portable ACL hook. TypeClaw accepts that
  // under the single-tenant dev-box model; the per-user/per-home pipe name keeps
  // the pipe scoped, while the separate HTTP leg remains restart/secrets-only.
  return `\\\\.\\pipe\\typeclaw-hostd-${hash}`
}

export function pidfilePath(): string {
  return join(runDir(), 'hostd.pid')
}

export function lockfilePath(): string {
  return join(runDir(), 'hostd.lock')
}

export function logfilePath(): string {
  return join(logDir(), 'hostd.log')
}

export function registrationsDir(): string {
  return join(runDir(), REGISTRATIONS_DIR)
}

export function agentOperationLocksDir(): string {
  return join(runDir(), AGENT_OPERATION_LOCKS_DIR)
}

export function agentOperationLockPath(containerName: string): string {
  if (!SAFE_NAME.test(containerName)) {
    throw new Error(`invalid container name for agent operation lock: ${JSON.stringify(containerName)}`)
  }
  return join(agentOperationLocksDir(), `${containerName}.lock`)
}

export function keysDir(): string {
  return join(homeRoot(), KEYS_DIR)
}

export function modelsDir(): string {
  return join(homeRoot(), 'models')
}

export function buildCacheDir(): string {
  return join(homeRoot(), 'build-cache')
}

export function versionCachePath(): string {
  return join(homeRoot(), 'version-cache.json')
}

// Throws on any name that could traverse out of registrationsDir() or
// confuse the filesystem. Caller's responsibility to handle the error;
// don't catch-and-ignore — an invalid name is a protocol violation.
export function registrationFilePath(containerName: string): string {
  if (!SAFE_NAME.test(containerName)) {
    throw new Error(`invalid container name for registration file: ${JSON.stringify(containerName)}`)
  }
  return join(registrationsDir(), `${containerName}.json`)
}

export async function ensureDirs(): Promise<void> {
  await mkdir(runDir(), { recursive: true })
  await mkdir(logDir(), { recursive: true })
  await mkdir(registrationsDir(), { recursive: true })
  await mkdir(keysDir(), { recursive: true })
  await mkdir(modelsDir(), { recursive: true })
  await chmod(runDir(), 0o700).catch(() => {})
  await chmod(logDir(), 0o700).catch(() => {})
  await chmod(registrationsDir(), 0o700).catch(() => {})
  await chmod(keysDir(), 0o700).catch(() => {})
  await chmod(modelsDir(), 0o700).catch(() => {})
}

export async function ensureAgentOperationLocksDir(): Promise<void> {
  await mkdir(agentOperationLocksDir(), { recursive: true })
  await chmod(agentOperationLocksDir(), 0o700).catch(() => {})
}
