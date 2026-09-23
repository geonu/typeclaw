import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import lockfile from 'proper-lockfile'

import { providerKeyDefaultEnv } from './defaults'
import { resolveSecret } from './resolve'
import {
  type Channels,
  type GithubCliSecrets,
  type McpCredential,
  type McpSlice,
  type ProviderCredential,
  type Providers,
  type SecretsFile,
  SECRETS_FILE_VERSION,
  parseSecretsFile,
} from './schema'

const SCHEMA_REL = './node_modules/typeclaw/secrets.schema.json'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const SYNC_LOCK_RETRIES = 10
const SYNC_LOCK_DELAY_MS = 20

const ASYNC_LOCK_OPTIONS = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
  stale: 30000,
} as const

// CredentialStore is pi 0.87's provider write boundary. Its modify callback
// runs under this file lock, so refresh and login remain serialized per
// provider across processes while non-provider envelope slices stay intact.
export class SecretsBackend implements CredentialStore {
  constructor(private readonly secretsPath: string) {}

  async read(providerId: string): Promise<Credential | undefined> {
    if (!existsSync(this.secretsPath)) return undefined
    return this.withProviderLock(() => toPiCredential(this.readEnvelope().providers[providerId], process.env))
  }

  async list(): Promise<readonly CredentialInfo[]> {
    if (!existsSync(this.secretsPath)) return []
    return this.withProviderLock(() =>
      Object.entries(this.readEnvelope().providers)
        .filter(([, credential]) => credential.type === 'api_key' || credential.type === 'oauth')
        .map(([providerId, credential]) => ({ providerId, type: credential.type })),
    )
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.secretsPath, ASYNC_LOCK_OPTIONS)
      const envelope = this.readEnvelope()
      const prior = envelope.providers[providerId]
      const next = await fn(toPiCredential(prior, process.env))
      if (next === undefined) return toPiCredential(prior, process.env)
      const credential = fromPiCredential(next, prior, providerId, process.env)
      this.writeEnvelopeAtomic({
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        providers: { ...envelope.providers, [providerId]: credential },
      })
      return toPiCredential(credential, process.env)
    } finally {
      await release?.()
    }
  }

  async delete(providerId: string): Promise<void> {
    if (!existsSync(this.secretsPath)) return
    await this.withProviderLock(() => {
      const envelope = this.readEnvelope()
      if (!(providerId in envelope.providers)) return
      const { [providerId]: _removed, ...providers } = envelope.providers
      this.writeEnvelopeAtomic({ ...envelope, providers })
    })
  }

  private async withProviderLock<T>(fn: () => T): Promise<T> {
    let release: (() => Promise<void>) | undefined
    try {
      release = await lockfile.lock(this.secretsPath, ASYNC_LOCK_OPTIONS)
      return fn()
    } finally {
      await release?.()
    }
  }

  readChannelsSync(): Channels {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().channels
    } finally {
      release?.()
    }
  }

  tryReadChannelsSync(): Channels | null {
    if (!existsSync(this.secretsPath)) return null
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().channels
    } finally {
      release?.()
    }
  }

  tryReadProviderApiKeySync(providerId: string, env: NodeJS.ProcessEnv = process.env): string | null {
    if (!existsSync(this.secretsPath)) return null
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const credential = this.readEnvelope().providers[providerId]
      if (credential?.type !== 'api_key') return null
      const resolved =
        resolveSecret(credential.key, providerKeyDefaultEnv(providerId), env) ?? credential.key.value ?? ''
      return resolved.trim() !== '' ? resolved : null
    } finally {
      release?.()
    }
  }
  // Returns a shallow snapshot of providers for host-stage CLI inspection
  // without resolving env overrides, so file-backed versus env-backed state
  // remains visible to the operator.
  tryReadProvidersSync(): Providers {
    if (!existsSync(this.secretsPath)) return {}
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return { ...this.readEnvelope().providers }
    } finally {
      release?.()
    }
  }

  tryReadMcpSync(): McpSlice {
    if (!existsSync(this.secretsPath)) return {}
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return { ...this.readEnvelope().mcp }
    } finally {
      release?.()
    }
  }

  tryReadGithubCliSync(): GithubCliSecrets | undefined {
    if (!existsSync(this.secretsPath)) return undefined
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().githubCli
    } finally {
      release?.()
    }
  }

  writeGithubCliSync(githubCli: GithubCliSecrets): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      this.writeEnvelopeAtomic({
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        githubCli,
      })
    } finally {
      release?.()
    }
  }

  readMcpCredentialSync(serverName: string): McpCredential | undefined {
    if (!existsSync(this.secretsPath)) return undefined
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      return this.readEnvelope().mcp[serverName]
    } finally {
      release?.()
    }
  }

  writeMcpCredentialSync(serverName: string, credential: McpCredential): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        mcp: { ...envelope.mcp, [serverName]: credential },
      }
      this.writeEnvelopeAtomic(next)
    } finally {
      release?.()
    }
  }

  async updateMcpAsync<T>(fn: (current: McpSlice) => Promise<{ result: T; next?: McpSlice }>): Promise<T> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    let lockCompromised = false
    let lockCompromisedError: Error | undefined
    const throwIfCompromised = (): void => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Secrets store lock was compromised')
      }
    }
    try {
      release = await lockfile.lock(this.secretsPath, {
        ...ASYNC_LOCK_OPTIONS,
        onCompromised: (err: Error) => {
          lockCompromised = true
          lockCompromisedError = err
        },
      })
      throwIfCompromised()
      const envelope = this.readEnvelope()
      const { result, next } = await fn(envelope.mcp)
      throwIfCompromised()
      if (next !== undefined) {
        const merged: SecretsFile = {
          ...envelope,
          $schema: envelope.$schema ?? SCHEMA_REL,
          version: SECRETS_FILE_VERSION,
          mcp: next,
        }
        this.writeEnvelopeAtomic(merged)
      }
      throwIfCompromised()
      return result
    } finally {
      if (release) {
        try {
          await release()
        } catch {}
      }
    }
  }

  removeMcpCredentialSync(serverName: string): boolean {
    if (!existsSync(this.secretsPath)) return false
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      if (!(serverName in envelope.mcp)) return false
      const { [serverName]: _removed, ...rest } = envelope.mcp
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        mcp: rest,
      }
      this.writeEnvelopeAtomic(next)
      return true
    } finally {
      release?.()
    }
  }

  // Host-stage CLI API-key write. OAuth login and refresh use CredentialStore
  // through ModelRuntime so rotating token state remains serialized.
  writeProviderCredentialSync(providerId: string, credential: ProviderCredential): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        providers: { ...envelope.providers, [providerId]: credential },
      }
      this.writeEnvelopeAtomic(next)
    } finally {
      release?.()
    }
  }

  // Removes `providers.<id>` from the envelope. Returns `true` when the
  // provider was present and removed, `false` when nothing changed (idempotent
  // on the CLI side — `provider remove fireworks` twice should not error on
  // the second call). The file is rewritten only when something changed so
  // canonical-shape reads pay zero cost.
  removeProviderCredentialSync(providerId: string): boolean {
    if (!existsSync(this.secretsPath)) return false
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      if (!(providerId in envelope.providers)) return false
      const { [providerId]: _removed, ...rest } = envelope.providers
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        providers: rest,
      }
      this.writeEnvelopeAtomic(next)
      return true
    } finally {
      release?.()
    }
  }

  // Removes `channels.<kind>` from the envelope. Returns `true` when the
  // adapter slot was present and removed, `false` when nothing changed
  // (idempotent on the CLI side — `channel remove discord-bot` twice should
  // not error on the second call). Mirrors `removeProviderCredentialSync`:
  // rewrites the file only when something changed so canonical-shape reads
  // pay zero cost.
  removeChannelSync(kind: string): boolean {
    if (!existsSync(this.secretsPath)) return false
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      if (!(kind in envelope.channels)) return false
      const { [kind]: _removed, ...rest } = envelope.channels
      const next: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        channels: rest,
      }
      this.writeEnvelopeAtomic(next)
      return true
    } finally {
      release?.()
    }
  }

  writeChannelsSync(next: Channels): void {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => void) | undefined
    try {
      release = this.acquireSyncLockWithRetry()
      const envelope = this.readEnvelope()
      const merged: SecretsFile = {
        ...envelope,
        $schema: envelope.$schema ?? SCHEMA_REL,
        version: SECRETS_FILE_VERSION,
        channels: next,
      }
      this.writeEnvelopeAtomic(merged)
    } finally {
      release?.()
    }
  }

  async updateChannelsAsync<T>(
    fn: (current: Record<string, unknown>) => Promise<{ result: T; next?: Record<string, unknown> }>,
  ): Promise<T> {
    this.ensureParentDir()
    this.ensureFileExists()
    let release: (() => Promise<void>) | undefined
    let lockCompromised = false
    let lockCompromisedError: Error | undefined
    const throwIfCompromised = (): void => {
      if (lockCompromised) {
        throw lockCompromisedError ?? new Error('Secrets store lock was compromised')
      }
    }
    try {
      release = await lockfile.lock(this.secretsPath, {
        ...ASYNC_LOCK_OPTIONS,
        onCompromised: (err: Error) => {
          lockCompromised = true
          lockCompromisedError = err
        },
      })
      throwIfCompromised()
      const envelope = this.readEnvelope()
      const { result, next } = await fn(envelope.channels as Record<string, unknown>)
      throwIfCompromised()
      if (next !== undefined) {
        const merged: SecretsFile = {
          ...envelope,
          $schema: envelope.$schema ?? SCHEMA_REL,
          channels: next as SecretsFile['channels'],
        }
        this.writeEnvelopeAtomic(merged)
      }
      throwIfCompromised()
      return result
    } finally {
      if (release) {
        try {
          await release()
        } catch {}
      }
    }
  }

  private ensureParentDir(): void {
    const dir = dirname(this.secretsPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    }
  }

  private ensureFileExists(): void {
    if (existsSync(this.secretsPath)) return
    const seed = newEmptyEnvelope()
    writeFileSync(this.secretsPath, stringifyEnvelope(seed), 'utf8')
    chmodSync(this.secretsPath, FILE_MODE)
  }

  private acquireSyncLockWithRetry(): () => void {
    let lastError: unknown
    for (let attempt = 1; attempt <= SYNC_LOCK_RETRIES; attempt++) {
      try {
        return lockfile.lockSync(this.secretsPath, { realpath: false })
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String((error as { code: unknown }).code)
            : undefined
        if (code !== 'ELOCKED' || attempt === SYNC_LOCK_RETRIES) throw error
        lastError = error
        const start = Date.now()
        while (Date.now() - start < SYNC_LOCK_DELAY_MS) {
          // intentionally empty: synchronous busy-wait to match upstream contract
        }
      }
    }
    throw (lastError as Error | undefined) ?? new Error('Failed to acquire secrets store lock')
  }

  private readEnvelope(): SecretsFile {
    const raw = existsSync(this.secretsPath) ? readFileSync(this.secretsPath, 'utf8') : ''
    if (!raw.trim()) return newEmptyEnvelope()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`secrets file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
    const result = parseSecretsFile(parsed)
    if (!result.ok) {
      throw new Error(`secrets file is not a valid TypeClaw secrets file: ${result.reason}`)
    }
    return result.file
  }

  private writeEnvelopeAtomic(envelope: SecretsFile): void {
    const tmp = `${this.secretsPath}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, stringifyEnvelope(envelope), { encoding: 'utf8', mode: FILE_MODE })
    try {
      renameSync(tmp, this.secretsPath)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        // best-effort cleanup of the temp file when rename fails
      }
      throw err
    }
    chmodSync(this.secretsPath, FILE_MODE)
  }
}

export function createSecretsStoreForAgent(secretsPath: string): SecretsBackend {
  return new SecretsBackend(secretsPath)
}

function newEmptyEnvelope(): SecretsFile {
  return { $schema: SCHEMA_REL, version: SECRETS_FILE_VERSION, providers: {}, channels: {}, mcp: {} }
}

function stringifyEnvelope(envelope: SecretsFile): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

// Preserve an untouched API-key Secret object byte-for-byte. Only an explicit
// non-empty credential mutation rewrites value while retaining an authored env
// binding; empty keys remain a no-op because v2 forbids empty Secret values.
function fromPiCredential(
  next: Credential,
  prior: ProviderCredential | undefined,
  providerId: string,
  env: NodeJS.ProcessEnv,
): ProviderCredential {
  if (next.type === 'oauth') return next as ProviderCredential
  if (!next.key) {
    if (prior) return prior
    throw new Error('Cannot persist an empty API key')
  }
  if (
    prior?.type === 'api_key' &&
    (resolveSecret(prior.key, providerKeyDefaultEnv(providerId), env) ?? prior.key.value) === next.key
  ) {
    return prior
  }
  return {
    type: 'api_key',
    key: prior?.type === 'api_key' && prior.key.env ? { value: next.key, env: prior.key.env } : { value: next.key },
  }
}

function toPiCredential(credential: ProviderCredential | undefined, env: NodeJS.ProcessEnv): Credential | undefined {
  if (!credential) return undefined
  if (credential.type === 'oauth') return credential as Credential
  const key = resolveSecret(credential.key, undefined, env) ?? credential.key.value
  return key ? { type: 'api_key', key } : undefined
}
