import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { CodingAgentAuthError, createCodingAgentAuthResolver } from './coding-agent-auth'
import { SecretsBackend } from './storage'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coding-auth-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('coding auth resolver', () => {
  test.each(['anthropic', 'openai-codex'] as const)(
    'coordinates %s refresh through the real canonical store',
    async (provider) => {
      const credentials = new SecretsBackend(join(dir, 'secrets.json'))
      await credentials.modify(provider, async () => ({
        type: 'oauth',
        access: 'old',
        refresh: 'refresh-old',
        expires: 0,
        accountId: 'account-before-refresh',
        idToken: 'id-token-canary',
      }))
      await credentials.modify('other', async () => ({ type: 'api_key', key: 'other-canary' }))
      let refreshed = 0
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
      runtime.registerProvider(provider, {
        oauth: {
          name: 'fixture',
          login: async () => {
            throw new Error('No login in tests')
          },
          refreshToken: async () => {
            refreshed++
            return {
              access: 'new',
              refresh: 'refresh-new',
              expires: Date.now() + 3_600_000,
              accountId: 'account-after-refresh',
            }
          },
          getApiKey: (credential) => credential.access,
        },
      })
      const resolver = await createCodingAgentAuthResolver(dir, { credentials, runtime })
      const [broker, main] = await Promise.all([
        resolver.resolve(undefined, undefined, provider),
        runtime.getAuth(provider, { env: {} }),
      ])
      expect(broker.token).toBe('new')
      expect(main?.auth.apiKey).toBe('new')
      expect(refreshed).toBe(1)
      expect(broker.provider).toBe(provider)
      expect(broker.secrets).toContain('id-token-canary')
      if (broker.provider === 'openai-codex') expect(broker.accountId).toBe('account-after-refresh')
      expect(await credentials.read('other')).toEqual({ type: 'api_key', key: 'other-canary' })
      const rejected = broker
      await credentials.modify(provider, async () => ({
        type: 'oauth',
        access: 'relogin',
        refresh: 'new-login',
        expires: Date.now() + 3_600_000,
        accountId: 'account-after-relogin',
      }))
      const relogin = await resolver.resolve(undefined, rejected, provider)
      expect(relogin.token).toBe('relogin')
      if (relogin.provider === 'openai-codex') expect(relogin.accountId).toBe('account-after-relogin')
      expect(refreshed).toBe(1)
    },
  )

  test('missing auth is nonfatal and a later credential repairs only this provider', async () => {
    const credentials = new SecretsBackend(join(dir, 'secrets.json'))
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    // Use an explicit empty auth context rather than the dev machine's environment.
    runtime.registerProvider('anthropic', { apiKey: '' })
    const resolver = await createCodingAgentAuthResolver(dir, { credentials, runtime })
    await expect(resolver.resolve()).rejects.toThrow('authentication is unavailable')
    await credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'fixture-key' }))
    expect((await resolver.resolve()).token).toBe('fixture-key')
  })

  test('Codex missing auth, API credentials and missing account never fall back to another provider', async () => {
    const credentials = new SecretsBackend(join(dir, 'secrets.json'))
    await credentials.modify('anthropic', async () => ({ type: 'api_key', key: 'anthropic-canary' }))
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    const resolver = await createCodingAgentAuthResolver(dir, { credentials, runtime })
    await expect(resolver.resolve(undefined, undefined, 'openai-codex')).rejects.toThrow('provider add openai-codex')
    await credentials.modify('openai-codex', async () => ({ type: 'api_key', key: 'not-subscription-auth' }))
    await expect(resolver.resolve(undefined, undefined, 'openai-codex')).rejects.toThrow('provider add openai-codex')
    await credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access-canary',
      refresh: 'refresh-canary',
      expires: Date.now() + 3_600_000,
    }))
    await expect(resolver.resolve(undefined, undefined, 'openai-codex')).rejects.toThrow('provider add openai-codex')
    expect((await resolver.resolve()).token).toBe('anthropic-canary')
    await credentials.modify('openai-codex', async (current) => ({
      ...current,
      type: 'oauth',
      access: 'access-canary',
      refresh: 'refresh-canary',
      expires: Date.now() + 3_600_000,
      accountId: 'trusted-account',
    }))
    expect(await resolver.resolve(undefined, undefined, 'openai-codex')).toMatchObject({
      provider: 'openai-codex',
      type: 'oauth',
      token: 'access-canary',
      accountId: 'trusted-account',
    })
  })

  test('normalizes refresh errors without reflecting any OAuth canary', async () => {
    const credentials = new SecretsBackend(join(dir, 'secrets.json'))
    await credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'access-canary',
      refresh: 'refresh-canary',
      idToken: 'id-canary',
      expires: 0,
      accountId: 'trusted-account',
    }))
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    runtime.registerProvider('openai-codex', {
      oauth: {
        name: 'fixture',
        login: async () => {
          throw new Error('No login in tests')
        },
        refreshToken: async () => {
          throw new Error('access-canary refresh-canary id-canary')
        },
        getApiKey: (credential) => credential.access,
      },
    })
    const resolver = await createCodingAgentAuthResolver(dir, { credentials, runtime })
    const error = await resolver.resolve(undefined, undefined, 'openai-codex').catch((error: unknown) => error)
    expect(error).toBeInstanceOf(CodingAgentAuthError)
    for (const token of ['access-canary', 'refresh-canary', 'id-canary']) {
      expect(String(error)).not.toContain(token)
      expect(JSON.stringify(error)).not.toContain(token)
    }
  })
})
