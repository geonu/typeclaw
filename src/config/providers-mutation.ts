import { join } from 'node:path'

import { SecretsBackend, type Secret } from '@/secrets'
import { providerKeyDefaultEnv } from '@/secrets/defaults'
import type { ProviderCredential, Providers } from '@/secrets/schema'

import { type ProfileEntry, loadConfigSync } from './config'
import { KNOWN_PROVIDERS, type KnownProviderId, type ModelRef, providerForModelRef } from './providers'

// Where a configured credential resolves from at runtime. Reported by
// `typeclaw provider list` so users can tell whether their key is coming from
// `secrets.json#providers.<id>.key.value`, from `process.env.<API_KEY_ENV>`, or
// from an explicit `{ env: 'CUSTOM_NAME' }` binding. Drives the post-mutation
// hints (e.g. "key is env-overridden — `provider remove` will not unset env").
export type CredentialSource =
  | { kind: 'file' }
  | { kind: 'env-only'; envName: string }
  | { kind: 'env-overridden'; envName: string }
  | { kind: 'oauth' }

export type ConfiguredProvider = {
  id: KnownProviderId | string
  known: boolean
  type: 'api_key' | 'oauth' | 'unknown'
  source: CredentialSource
  envName: string | undefined
  referencedByProfiles: string[]
}

export type ProviderAddCredential =
  | { type: 'api_key'; key: string; envBinding?: string | undefined }
  | { type: 'env-binding'; envBinding: string }

export type ProviderMutationResult = { ok: true } | { ok: false; reason: string }

const SECRETS_FILE = 'secrets.json'

export function listConfiguredProviders(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfiguredProvider[] {
  const backend = new SecretsBackend(join(cwd, SECRETS_FILE))
  const providers = backend.tryReadProvidersSync()
  const models = readModelsOrNull(cwd)
  const referencedByProfiles = buildProviderReferenceMap(models)

  const ids = new Set<string>([...Object.keys(providers), ...Object.keys(KNOWN_PROVIDERS)])
  const out: ConfiguredProvider[] = []
  for (const id of ids) {
    const credential = providers[id]
    const known = id in KNOWN_PROVIDERS
    if (credential === undefined) {
      // Known provider with no file entry. Surface it only when an env var
      // makes it usable; otherwise it's not "configured" and shouldn't appear
      // in the list (would clutter output for the 5+ known providers users
      // haven't touched).
      const envName = providerKeyDefaultEnv(id)
      if (envName !== undefined && readEnvKey(env, envName) !== undefined) {
        out.push({
          id: id as KnownProviderId,
          known,
          type: 'api_key',
          source: { kind: 'env-only', envName },
          envName,
          referencedByProfiles: referencedByProfiles.get(id) ?? [],
        })
      }
      continue
    }
    out.push({
      id,
      known,
      type: credentialType(credential),
      source: credentialSource(id, credential, env),
      envName: effectiveEnvName(id, credential),
      referencedByProfiles: referencedByProfiles.get(id) ?? [],
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

export function isProviderConfigured(cwd: string, providerId: string): boolean {
  const backend = new SecretsBackend(join(cwd, SECRETS_FILE))
  return providerId in backend.tryReadProvidersSync()
}

// Refuses to overwrite an existing provider — callers must use `setProvider`
// for the rotate path. Keeps the "I'm adding fresh credentials" intent
// distinct from the "I'm rotating an existing key" intent at the file-write
// boundary, so an `add` typo can't silently displace a working key.
export function addProvider(
  cwd: string,
  providerId: KnownProviderId,
  credential: ProviderAddCredential,
): ProviderMutationResult {
  if (isProviderConfigured(cwd, providerId)) {
    return {
      ok: false,
      reason: `Provider "${providerId}" is already configured in secrets.json. Use \`typeclaw provider set\` to rotate its credentials.`,
    }
  }
  return writeApiKeyCredential(cwd, providerId, credential)
}

export function setProvider(
  cwd: string,
  providerId: KnownProviderId,
  credential: ProviderAddCredential,
): ProviderMutationResult {
  return writeApiKeyCredential(cwd, providerId, credential)
}

// Refuses removal when any model profile in typeclaw.json references the
// provider — clearing the credential out from under an active profile would
// crash the next session start with a missing-credential error. Returns the
// list of offending profiles so the CLI can name them in the error message.
export type ProviderRemovalResult =
  | { ok: true; existed: boolean }
  | { ok: false; reason: 'referenced'; profiles: string[] }

export function removeProvider(
  cwd: string,
  providerId: string,
  options: { force?: boolean } = {},
): ProviderRemovalResult {
  if (options.force !== true) {
    const profiles = findModelsReferencingProvider(cwd, providerId)
    if (profiles.length > 0) {
      return { ok: false, reason: 'referenced', profiles }
    }
  }
  const backend = new SecretsBackend(join(cwd, SECRETS_FILE))
  const existed = backend.removeProviderCredentialSync(providerId)
  return { ok: true, existed }
}

export function findModelsReferencingProvider(cwd: string, providerId: string): string[] {
  const models = readModelsOrNull(cwd)
  if (models === null) return []
  const out: string[] = []
  for (const [profile, entry] of Object.entries(models)) {
    if (entry.refs.some((r) => refTargetsProvider(r, providerId))) out.push(profile)
  }
  return out
}

function writeApiKeyCredential(
  cwd: string,
  providerId: KnownProviderId,
  credential: ProviderAddCredential,
): ProviderMutationResult {
  if (!(providerId in KNOWN_PROVIDERS)) {
    return { ok: false, reason: `Unknown provider "${providerId}".` }
  }
  const provider = KNOWN_PROVIDERS[providerId]
  if (provider.apiKeyEnv === null) {
    return {
      ok: false,
      reason: `Provider "${providerId}" does not support api-key authentication. Use \`typeclaw provider add ${providerId} --oauth\` instead.`,
    }
  }
  const secret = buildSecret(credential)
  if (secret === null) {
    return { ok: false, reason: 'API key cannot be empty.' }
  }
  const backend = new SecretsBackend(join(cwd, SECRETS_FILE))
  backend.writeProviderCredentialSync(providerId, { type: 'api_key', key: secret })
  return { ok: true }
}

function buildSecret(credential: ProviderAddCredential): Secret | null {
  if (credential.type === 'env-binding') {
    return { env: credential.envBinding }
  }
  if (credential.key.length === 0) return null
  if (credential.envBinding !== undefined && credential.envBinding.length > 0) {
    return { value: credential.key, env: credential.envBinding }
  }
  return { value: credential.key }
}

function credentialType(credential: ProviderCredential): 'api_key' | 'oauth' | 'unknown' {
  if (credential.type === 'api_key') return 'api_key'
  if (credential.type === 'oauth') return 'oauth'
  return 'unknown'
}

function credentialSource(
  providerId: string,
  credential: ProviderCredential,
  env: NodeJS.ProcessEnv,
): CredentialSource {
  if (credential.type === 'oauth') return { kind: 'oauth' }
  if (credential.type !== 'api_key') return { kind: 'file' }
  const envName = credential.key.env ?? providerKeyDefaultEnv(providerId)
  if (envName !== undefined && readEnvKey(env, envName) !== undefined) {
    if (credential.key.value === undefined) return { kind: 'env-only', envName }
    return { kind: 'env-overridden', envName }
  }
  return { kind: 'file' }
}

function effectiveEnvName(providerId: string, credential: ProviderCredential): string | undefined {
  if (credential.type !== 'api_key') return undefined
  return credential.key.env ?? providerKeyDefaultEnv(providerId)
}

function readEnvKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]
  if (value === undefined || value === '') return undefined
  return value
}

function buildProviderReferenceMap(models: Record<string, ProfileEntry> | null): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (models === null) return out
  for (const [profile, entry] of Object.entries(models)) {
    for (const ref of entry.refs) {
      const providerId = safeProviderForRef(ref)
      if (providerId === null) continue
      const existing = out.get(providerId) ?? []
      if (!existing.includes(profile)) {
        existing.push(profile)
        out.set(providerId, existing)
      }
    }
  }
  return out
}

function refTargetsProvider(ref: string, providerId: string): boolean {
  return ref.startsWith(`${providerId}/`)
}

function safeProviderForRef(ref: ModelRef): KnownProviderId | null {
  try {
    return providerForModelRef(ref)
  } catch {
    return null
  }
}

// Every profile that can put a provider in use: global `models` plus each
// `modelOverrides` entry's profiles, labelled `modelOverrides.<name>.<profile>`
// so removal guards and listings name the override that still needs the provider.
function readModelsOrNull(cwd: string): Record<string, ProfileEntry> | null {
  try {
    const config = loadConfigSync(cwd)
    const out: Record<string, ProfileEntry> = { ...config.models }
    for (const [name, override] of Object.entries(config.modelOverrides)) {
      for (const [profile, entry] of Object.entries(override.models)) out[`modelOverrides.${name}.${profile}`] = entry
    }
    return out
  } catch {
    return null
  }
}

export type ProviderListEntry = ConfiguredProvider

export type ProvidersSnapshot = {
  providers: Providers
  configuredIds: string[]
}
