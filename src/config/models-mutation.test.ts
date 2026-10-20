import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scaffold, writeSecrets } from '@/init'

import {
  addProfile,
  isKnownModelRef,
  listAvailableModelRefs,
  listModelProfiles,
  listRegisteredModelRefs,
  addOverrideMatch,
  listModelOverrides,
  removeOverride,
  removeOverrideMatch,
  removeOverrideProfile,
  removeProfile,
  setOverrideProfile,
  setProfile,
  setProfileThinkingLevel,
} from './models-mutation'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-models-mutation-'))
  await scaffold(root, { model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo' })
  await writeSecrets(root, {
    model: 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    apiKey: 'fw_initial',
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function readModels(): Promise<Record<string, string>> {
  const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
  const parsed = JSON.parse(raw) as { models?: Record<string, string> }
  return parsed.models ?? {}
}

async function readCustomModels(): Promise<Record<string, unknown>> {
  const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
  const parsed = JSON.parse(raw) as { customModels?: Record<string, unknown> }
  return parsed.customModels ?? {}
}

describe('listAvailableModelRefs', () => {
  test('returns all KNOWN_PROVIDERS model refs', () => {
    const refs = listAvailableModelRefs()
    expect(refs).toContain('openai/gpt-5.4-nano')
    expect(refs).toContain('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(refs.length).toBeGreaterThan(5)
  })
})

describe('listRegisteredModelRefs', () => {
  test('returns only models whose providers have a secrets.json entry', () => {
    const refs = listRegisteredModelRefs(root, {})
    expect(refs).toEqual(['fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'])
  })

  test('includes models for providers configured purely via env var', () => {
    const refs = listRegisteredModelRefs(root, { OPENAI_API_KEY: 'sk_test' })
    expect(refs).toContain('openai/gpt-5.4-nano')
    expect(refs).toContain('openai/gpt-5.4')
    expect(refs).toContain('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(refs.every((r) => r.startsWith('openai/') || r.startsWith('fireworks/'))).toBe(true)
  })

  test('returns empty when no provider is configured (file or env)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'typeclaw-models-mutation-empty-'))
    try {
      await scaffold(empty, { model: 'openai/gpt-5.4-nano' })
      expect(listRegisteredModelRefs(empty, {})).toEqual([])
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test('preserves listKnownModelRefs declaration order', () => {
    const refs = listRegisteredModelRefs(root, { OPENAI_API_KEY: 'sk_test', FIREWORKS_API_KEY: 'fw_test' })
    const known = listAvailableModelRefs()
    const indexed = refs.map((r) => known.indexOf(r))
    const sorted = [...indexed].sort((a, b) => a - b)
    expect(indexed).toEqual(sorted)
  })
})

describe('isKnownModelRef', () => {
  test('accepts canonical refs', () => {
    expect(isKnownModelRef('openai/gpt-5.4-nano')).toBe(true)
  })

  test('rejects unknown refs', () => {
    expect(isKnownModelRef('mystery/model')).toBe(false)
    expect(isKnownModelRef('')).toBe(false)
    expect(isKnownModelRef('fireworks')).toBe(false)
  })
})

describe('setProfile', () => {
  test('updates the default profile when credentials are present', async () => {
    const result = setProfile(root, 'default', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect((await readModels()).default).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
  })

  test('creates a new profile beside default', async () => {
    setProfile(root, 'default', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const result = setProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect((await readModels()).fast).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
  })

  test('refuses unknown model refs', () => {
    const result = setProfile(root, 'default', 'mystery/model')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Unknown model')
  })

  test('refuses empty profile names', () => {
    const result = setProfile(root, '   ', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Profile name')
  })

  test('refuses when target provider has no credentials', () => {
    const env: NodeJS.ProcessEnv = {}
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('has no credentials')
    expect(result.reason).toContain('typeclaw provider add openai')
    expect(result.reason).toContain('--force')
  })

  test('proceeds when target provider credentials come from env', () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-from-env' }
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env })
    expect(result.ok).toBe(true)
  })

  test('accepts a custom model ref for a known provider without metadata', async () => {
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-from-env' }
    const result = setProfile(root, 'default', 'openai/gpt-6-live', { env })
    expect(result.ok).toBe(true)
    expect((await readModels()).default).toBe('openai/gpt-6-live')
    expect(await readCustomModels()).toEqual({})
  })

  test('writes customModels metadata for a custom model ref in the same mutation', async () => {
    const ref = 'fireworks/accounts/fireworks/models/qwen3-next'
    const result = setProfile(root, 'default', ref, {
      meta: {
        name: 'Qwen3 Next',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    })
    expect(result.ok).toBe(true)
    expect((await readModels()).default).toBe(ref)
    expect(await readCustomModels()).toEqual({
      [ref]: {
        name: 'Qwen3 Next',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 262144,
        maxTokens: 32768,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    })
  })

  test('force=true writes even without credentials', () => {
    const env: NodeJS.ProcessEnv = {}
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env, force: true })
    expect(result.ok).toBe(true)
  })

  test.skipIf(process.platform === 'win32')(
    'reports actionable ownership guidance when typeclaw.json is not writable',
    async () => {
      // given
      const configPath = join(root, 'typeclaw.json')
      await chmod(configPath, 0o444)

      // when
      const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', {
        env: { OPENAI_API_KEY: 'sk-from-env' },
      })

      // then
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain('not writable by the current user')
      expect(result.reason).toContain('ls -ln')
      expect(result.reason).toContain('sudo chown')

      await chmod(configPath, 0o600)
    },
  )
})

describe('addProfile', () => {
  test('refuses to overwrite an existing profile', () => {
    const result = addProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('already exists')
    expect(result.reason).toContain('typeclaw model set')
  })

  test('creates a fresh profile', async () => {
    const result = addProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect((await readModels()).fast).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
  })
})

describe('removeProfile', () => {
  test('refuses to remove the default profile', () => {
    const result = removeProfile(root, 'default')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Cannot remove')
    expect(result.reason).toContain('model set default')
  })

  test('removes a non-default profile', async () => {
    addProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const result = removeProfile(root, 'fast')
    expect(result.ok).toBe(true)
    const models = await readModels()
    expect(models).not.toHaveProperty('fast')
    expect(models.default).toBeDefined()
  })

  test('errors when profile does not exist', () => {
    const result = removeProfile(root, 'nonexistent')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not found')
  })
})

describe('listModelProfiles', () => {
  test('lists default first, then alphabetical', () => {
    addProfile(root, 'zeta', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    addProfile(root, 'alpha', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const entries = listModelProfiles(root)
    expect(entries.map((e) => e.profile)).toEqual(['default', 'alpha', 'zeta'])
    expect(entries[0]?.isDefault).toBe(true)
    expect(entries[1]?.isDefault).toBe(false)
  })

  test('marks profiles with missing credentials', () => {
    addProfile(root, 'vision', 'openai/gpt-5.4-mini', { force: true })
    const env: NodeJS.ProcessEnv = {}
    const entries = listModelProfiles(root, env)
    const vision = entries.find((e) => e.profile === 'vision')
    expect(vision?.credentialStatus).toBe('missing-credentials')
    const dflt = entries.find((e) => e.profile === 'default')
    expect(dflt?.credentialStatus).toBe('available')
  })

  test('credentialStatus uses env override when set', () => {
    addProfile(root, 'vision', 'openai/gpt-5.4-mini', { force: true })
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-x' }
    const entries = listModelProfiles(root, env)
    const vision = entries.find((e) => e.profile === 'vision')
    expect(vision?.credentialStatus).toBe('available')
  })

  test('exposes fallback chains via refs and reports missing providers across the chain', async () => {
    const { writeFile } = await import('node:fs/promises')
    // fireworks is configured via the test setup's secrets.json; openai is
    // not, so a chain that includes both should be flagged missing-credentials
    // with `openai` named in `missingProviders`.
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['fireworks/accounts/fireworks/routers/kimi-k2p6-turbo', 'openai/gpt-5.4-nano'],
        },
      }),
    )
    const env: NodeJS.ProcessEnv = {}
    const entries = listModelProfiles(root, env)
    const dflt = entries.find((e) => e.profile === 'default')
    expect(String(dflt?.ref)).toBe('fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(dflt?.refs.map(String)).toEqual([
      'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
      'openai/gpt-5.4-nano',
    ])
    expect(dflt?.credentialStatus).toBe('missing-credentials')
    expect(dflt?.missingProviders).toEqual(['openai'])
  })

  test('reports available when every provider in the chain has credentials', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['fireworks/accounts/fireworks/routers/kimi-k2p6-turbo', 'openai/gpt-5.4-nano'],
        },
      }),
    )
    const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-x' }
    const entries = listModelProfiles(root, env)
    const dflt = entries.find((e) => e.profile === 'default')
    expect(dflt?.credentialStatus).toBe('available')
    expect(dflt?.missingProviders).toEqual([])
  })

  test('dedupes providers when the chain uses multiple models from the same provider', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      join(root, 'typeclaw.json'),
      JSON.stringify({
        models: {
          default: ['openai/gpt-5.4-nano', 'openai/gpt-5.4-mini'],
        },
      }),
    )
    const env: NodeJS.ProcessEnv = {}
    const entries = listModelProfiles(root, env)
    const dflt = entries.find((e) => e.profile === 'default')
    expect(dflt?.missingProviders).toEqual(['openai'])
  })

  test('falls back to default models when typeclaw.json is malformed JSON instead of throwing', async () => {
    await writeFile(join(root, 'typeclaw.json'), 'NOT JSON AT ALL {{{')
    const entries = listModelProfiles(root, {})
    expect(entries.length).toBe(1)
    expect(entries[0]?.profile).toBe('default')
    expect(entries[0]?.isDefault).toBe(true)
  })

  test('falls back to default models when typeclaw.json is schema-invalid instead of throwing', async () => {
    await writeFile(join(root, 'typeclaw.json'), JSON.stringify({ models: { default: 'not-a-known-model' } }))
    const entries = listModelProfiles(root, {})
    expect(entries.length).toBe(1)
    expect(entries[0]?.profile).toBe('default')
    expect(entries[0]?.isDefault).toBe(true)
  })
})

describe('auto-commit on success', () => {
  async function runGit(cwd: string, args: string[]): Promise<string> {
    const proc = Bun.spawn({ cmd: ['git', ...args], cwd, stdout: 'pipe', stderr: 'pipe' })
    await proc.exited
    return (await new Response(proc.stdout).text()).trim()
  }

  async function initGit(cwd: string): Promise<void> {
    for (const cmd of [
      ['init', '-b', 'main'],
      ['config', 'user.name', 'Test User'],
      ['config', 'user.email', 'test@example.com'],
      ['add', '.'],
      ['commit', '-m', 'initial'],
    ]) {
      const proc = Bun.spawn({ cmd: ['git', ...cmd], cwd, stdout: 'pipe', stderr: 'pipe' })
      await proc.exited
    }
  }

  test('setProfile commits typeclaw.json with a "model: set" subject', async () => {
    await initGit(root)
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(result.ok).toBe(true)
    expect(await runGit(root, ['log', '-1', '--format=%s'])).toBe('model: set default → openai/gpt-5.4-nano')
    expect(await runGit(root, ['show', '--name-only', '--format=', 'HEAD'])).toBe('typeclaw.json')
  })

  test('addProfile commits typeclaw.json with a "model: add" subject', async () => {
    await initGit(root)
    const result = addProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    expect(result.ok).toBe(true)
    expect(await runGit(root, ['log', '-1', '--format=%s'])).toBe(
      'model: add fast → fireworks/accounts/fireworks/routers/kimi-k2p6-turbo',
    )
  })

  test('removeProfile commits typeclaw.json with a "model: remove" subject', async () => {
    addProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    await initGit(root)
    const result = removeProfile(root, 'fast')
    expect(result.ok).toBe(true)
    expect(await runGit(root, ['log', '-1', '--format=%s'])).toBe('model: remove fast')
  })

  test('setProfileThinkingLevel commits typeclaw.json with a per-profile subject', async () => {
    await initGit(root)
    const result = setProfileThinkingLevel(root, 'default', 'high')
    expect(result.ok).toBe(true)
    expect(await runGit(root, ['log', '-1', '--format=%s'])).toBe('model: set thinkingLevel high for default')
  })

  test('no-ops when the folder is not a git repo (mutation-check anchor for the commit call)', async () => {
    const before = await readFile(join(root, 'typeclaw.json'), 'utf8')
    const result = setProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(result.ok).toBe(true)
    expect(await readFile(join(root, 'typeclaw.json'), 'utf8')).not.toBe(before)
  })

  test('failed mutation does not produce a commit', async () => {
    await initGit(root)
    const head = await runGit(root, ['rev-parse', 'HEAD'])
    const result = setProfile(root, 'default', 'mystery/model')
    expect(result.ok).toBe(false)
    expect(await runGit(root, ['rev-parse', 'HEAD'])).toBe(head)
  })
})

describe('setProfileThinkingLevel', () => {
  async function readProfileRaw(profile: string): Promise<unknown> {
    const raw = await readFile(join(root, 'typeclaw.json'), 'utf8')
    return (JSON.parse(raw) as { models?: Record<string, unknown> }).models?.[profile]
  }

  test('promotes a bare-ref profile to a rich object carrying the level', async () => {
    const before = await readProfileRaw('default')
    expect(typeof before).toBe('string')
    const result = setProfileThinkingLevel(root, 'default', 'high')
    expect(result.ok).toBe(true)
    expect(await readProfileRaw('default')).toEqual({ models: before, thinkingLevel: 'high' })
  })

  test('overwrites an existing per-profile level, preserving the refs', async () => {
    setProfileThinkingLevel(root, 'default', 'low')
    const refs = (await readProfileRaw('default')) as { models: unknown }
    const result = setProfileThinkingLevel(root, 'default', 'xhigh')
    expect(result.ok).toBe(true)
    expect(await readProfileRaw('default')).toEqual({ models: refs.models, thinkingLevel: 'xhigh' })
  })

  test('passing undefined collapses the profile back to its bare ref', async () => {
    const bare = await readProfileRaw('default')
    setProfileThinkingLevel(root, 'default', 'medium')
    const result = setProfileThinkingLevel(root, 'default', undefined)
    expect(result.ok).toBe(true)
    expect(await readProfileRaw('default')).toEqual(bare)
  })

  test('targets only the named profile, leaving siblings untouched', async () => {
    setProfile(root, 'fast', 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo')
    const fastBefore = await readProfileRaw('fast')
    setProfileThinkingLevel(root, 'default', 'high')
    expect(await readProfileRaw('fast')).toEqual(fastBefore)
  })

  test('rejects a profile that does not exist yet', () => {
    const result = setProfileThinkingLevel(root, 'nonexistent', 'high')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('not found')
  })

  test('rejects an empty profile name', () => {
    const result = setProfileThinkingLevel(root, '   ', 'high')
    expect(result.ok).toBe(false)
  })

  test('setting a level then re-setting the ref preserves the level', async () => {
    setProfileThinkingLevel(root, 'default', 'high')
    setProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(await readProfileRaw('default')).toEqual({ models: 'openai/gpt-5.4-nano', thinkingLevel: 'high' })
  })

  test('setProfile with an explicit thinkingLevel writes both atomically', async () => {
    setProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' }, thinkingLevel: 'low' })
    expect(await readProfileRaw('default')).toEqual({ models: 'openai/gpt-5.4-nano', thinkingLevel: 'low' })
  })

  test('setProfile with an explicit `thinkingLevel: undefined` clears an existing level', async () => {
    setProfileThinkingLevel(root, 'default', 'high')
    setProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' }, thinkingLevel: undefined })
    expect(await readProfileRaw('default')).toBe('openai/gpt-5.4-nano')
  })

  test('setProfile omitting the thinkingLevel key preserves an existing level', async () => {
    setProfileThinkingLevel(root, 'default', 'high')
    setProfile(root, 'default', 'openai/gpt-5.4-nano', { env: { OPENAI_API_KEY: 'x' } })
    expect(await readProfileRaw('default')).toEqual({ models: 'openai/gpt-5.4-nano', thinkingLevel: 'high' })
  })
})

describe('model overrides', () => {
  const FW = 'fireworks/accounts/fireworks/routers/kimi-k2p6-turbo'

  test('set creates an override with --match, then edits profiles and rules by name', () => {
    expect(setOverrideProfile(root, 'support', 'default', FW, { match: 'slack:T0123/C0123' }).ok).toBe(true)
    expect(setOverrideProfile(root, 'support', 'fast', FW, { thinkingLevel: 'off' }).ok).toBe(true)
    expect(addOverrideMatch(root, 'support', 'discord:G1/C2').ok).toBe(true)

    expect(listModelOverrides(root) as unknown).toEqual([
      {
        name: 'support',
        match: ['slack:T0123/C0123', 'discord:G1/C2'],
        profiles: [
          { profile: 'default', refs: [FW] },
          { profile: 'fast', refs: [FW], thinkingLevel: 'off' },
        ],
      },
    ])
  })

  test('creating an override without --match is refused', () => {
    expect(setOverrideProfile(root, 'support', 'default', FW).ok).toBe(false)
    expect(listModelOverrides(root)).toEqual([])
  })

  test('invalid rules and uncredentialed providers are refused unless forced', () => {
    expect(setOverrideProfile(root, 'a', 'default', FW, { match: 'slak:*' }).ok).toBe(false)
    expect(setOverrideProfile(root, 'a', 'default', 'openai/gpt-5.4-nano', { match: 'slack:*', env: {} }).ok).toBe(
      false,
    )
    expect(
      setOverrideProfile(root, 'a', 'default', 'openai/gpt-5.4-nano', { match: 'slack:*', env: {}, force: true }).ok,
    ).toBe(true)
  })

  test('removing the last rule is refused; removing the last profile drops the override', () => {
    setOverrideProfile(root, 'support', 'default', FW, { match: 'slack:*' })
    expect(removeOverrideMatch(root, 'support', 'slack:*').ok).toBe(false)
    expect(removeOverrideProfile(root, 'support', 'default').ok).toBe(true)
    expect(listModelOverrides(root)).toEqual([])
    expect(removeOverride(root, 'support').ok).toBe(false)
  })
})
