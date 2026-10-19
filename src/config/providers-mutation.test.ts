import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scaffold, writeSecrets } from '@/init'

import {
  addProvider,
  findModelsReferencingProvider,
  isProviderConfigured,
  listConfiguredProviders,
  removeProvider,
  setProvider,
} from './providers-mutation'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-providers-mutation-'))
  await scaffold(root, { model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
  await writeSecrets(root, {
    model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    apiKey: 'fw_initial',
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readSecretsProviders(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, 'secrets.json'), 'utf8')
  const parsed = JSON.parse(raw) as { providers?: Record<string, unknown> }
  return parsed.providers ?? {}
}

describe('isProviderConfigured', () => {
  test('returns true for a provider with a file entry', () => {
    expect(isProviderConfigured(root, 'fireworks')).toBe(true)
  })

  test('returns false for a provider without a file entry, even if known', () => {
    expect(isProviderConfigured(root, 'openai')).toBe(false)
  })
})

describe('addProvider', () => {
  test('writes a fresh api_key credential to secrets.json#providers.<id>', () => {
    const result = addProvider(root, 'openai', { type: 'api_key', key: 'sk-new' })
    expect(result.ok).toBe(true)
  })

  test('refuses when the provider already has an entry', () => {
    const result = addProvider(root, 'fireworks', { type: 'api_key', key: 'fw_other' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already configured')
    expect(result.reason).toContain('provider set')
  })

  test('refuses oauth-only providers on the api-key path', () => {
    const result = addProvider(root, 'openai-codex', { type: 'api_key', key: 'sk-codex' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('does not support api-key authentication')
  })

  test('writes an env-binding without a value when type=env-binding', async () => {
    addProvider(root, 'openai', { type: 'env-binding', envBinding: 'MY_OPENAI' })
    const providers = await readSecretsProviders()
    expect(providers.openai).toEqual({ type: 'api_key', key: { env: 'MY_OPENAI' } })
  })

  test('writes value+env when both are provided', async () => {
    addProvider(root, 'openai', { type: 'api_key', key: 'sk-x', envBinding: 'MY_OPENAI' })
    const providers = await readSecretsProviders()
    expect(providers.openai).toEqual({ type: 'api_key', key: { value: 'sk-x', env: 'MY_OPENAI' } })
  })
})

describe('setProvider', () => {
  test('rotates an existing api_key credential', async () => {
    setProvider(root, 'fireworks', { type: 'api_key', key: 'fw_rotated' })
    const providers = await readSecretsProviders()
    expect(providers.fireworks).toEqual({ type: 'api_key', key: { value: 'fw_rotated' } })
  })

  test('creates the entry when missing (same as addProvider for fresh providers)', async () => {
    setProvider(root, 'openai', { type: 'api_key', key: 'sk-new' })
    expect(isProviderConfigured(root, 'openai')).toBe(true)
  })
})

describe('findModelsReferencingProvider', () => {
  test('returns the profile names that reference a provider', async () => {
    const configPath = join(root, 'typeclaw.json')
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    cfg.models = {
      default: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      fast: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      vision: 'openai/gpt-5.4-mini',
    }
    await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`)

    expect(findModelsReferencingProvider(root, 'fireworks').sort()).toEqual(['default', 'fast'])
    expect(findModelsReferencingProvider(root, 'openai')).toEqual(['vision'])
    expect(findModelsReferencingProvider(root, 'zai')).toEqual([])
  })

  test('counts modelOverrides profiles, including fallback refs, so removal is guarded', async () => {
    // given a provider referenced only by a channel override's fallback chain
    const configPath = join(root, 'typeclaw.json')
    const cfg = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    cfg.modelOverrides = {
      support: {
        match: ['slack:*'],
        models: { default: ['fireworks/accounts/fireworks/routers/kimi-k2p6-turbo', 'openai/gpt-5.4-mini'] },
      },
    }
    await writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`)
    addProvider(root, 'openai', { type: 'api_key', key: 'sk-x' })

    // when / then
    expect(findModelsReferencingProvider(root, 'openai')).toEqual(['modelOverrides.support.default'])
    const result = removeProvider(root, 'openai')
    expect(result.ok).toBe(false)
    expect(removeProvider(root, 'openai', { force: true }).ok).toBe(true)
  })
})

describe('removeProvider', () => {
  test('refuses when any model profile references the provider', () => {
    const result = removeProvider(root, 'fireworks')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('referenced')
    expect(result.profiles).toEqual(['default'])
  })

  test('removes when no profile references the provider', async () => {
    addProvider(root, 'openai', { type: 'api_key', key: 'sk-x' })
    const result = removeProvider(root, 'openai')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.existed).toBe(true)
    expect(await readSecretsProviders()).not.toHaveProperty('openai')
  })

  test('reports existed=false when called on an absent provider', () => {
    const result = removeProvider(root, 'zai')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.existed).toBe(false)
  })

  test('force=true bypasses the model-reference check', async () => {
    const result = removeProvider(root, 'fireworks', { force: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.existed).toBe(true)
    expect(await readSecretsProviders()).not.toHaveProperty('fireworks')
  })
})

describe('listConfiguredProviders', () => {
  test('reports file-backed providers with kind=file', () => {
    const env: NodeJS.ProcessEnv = {}
    const entries = listConfiguredProviders(root, env)
    const fireworks = entries.find((e) => e.id === 'fireworks')
    expect(fireworks).toBeDefined()
    expect(fireworks?.source).toEqual({ kind: 'file' })
    expect(fireworks?.referencedByProfiles).toEqual(['default'])
  })

  test('reports env-overridden when both file and env are set', () => {
    const env: NodeJS.ProcessEnv = { FIREWORKS_API_KEY: 'fw_from_env' }
    const entries = listConfiguredProviders(root, env)
    const fireworks = entries.find((e) => e.id === 'fireworks')
    expect(fireworks?.source).toEqual({ kind: 'env-overridden', envName: 'FIREWORKS_API_KEY' })
  })

  test('reports env-only when env is set but no file entry exists', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-from-env' }
    const entries = listConfiguredProviders(root, env)
    const openai = entries.find((e) => e.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai?.source).toEqual({ kind: 'env-only', envName: 'OPENAI_API_KEY' })
  })

  test('omits known providers with no env and no file entry', () => {
    const env: NodeJS.ProcessEnv = {}
    const entries = listConfiguredProviders(root, env)
    expect(entries.find((e) => e.id === 'openai')).toBeUndefined()
    expect(entries.find((e) => e.id === 'zai')).toBeUndefined()
  })

  test('respects explicit env binding over the canonical env var', () => {
    setProvider(root, 'fireworks', { type: 'env-binding', envBinding: 'MY_FW' })
    const env: NodeJS.ProcessEnv = { FIREWORKS_API_KEY: 'should-be-ignored', MY_FW: 'fw_real' }
    const entries = listConfiguredProviders(root, env)
    const fireworks = entries.find((e) => e.id === 'fireworks')
    expect(fireworks?.envName).toBe('MY_FW')
    expect(fireworks?.source).toEqual({ kind: 'env-only', envName: 'MY_FW' })
  })
})
