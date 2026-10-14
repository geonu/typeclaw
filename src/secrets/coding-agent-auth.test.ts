import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { createCodingAgentAuthResolver } from './coding-agent-auth'
import { SecretsBackend } from './storage'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coding-auth-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('coding auth resolver', () => {
  test('coordinates main-agent and broker refresh through the real canonical store', async () => {
    const credentials = new SecretsBackend(join(dir, 'secrets.json'))
    await credentials.modify('anthropic', async () => ({
      type: 'oauth',
      access: 'old',
      refresh: 'refresh-old',
      expires: 0,
    }))
    await credentials.modify('other', async () => ({ type: 'api_key', key: 'other-canary' }))
    let refreshed = 0
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false })
    runtime.registerProvider('anthropic', {
      oauth: {
        name: 'fixture',
        login: async () => {
          throw new Error('No login in tests')
        },
        refreshToken: async () => {
          refreshed++
          return { access: 'new', refresh: 'refresh-new', expires: Date.now() + 3_600_000 }
        },
        getApiKey: (credential) => credential.access,
      },
    })
    const resolver = await createCodingAgentAuthResolver(dir, { credentials, runtime })
    const [broker, main] = await Promise.all([resolver.resolve(), runtime.getAuth('anthropic', { env: {} })])
    expect(broker.token).toBe('new')
    expect(main?.auth.apiKey).toBe('new')
    expect(refreshed).toBe(1)
    expect(await credentials.read('other')).toEqual({ type: 'api_key', key: 'other-canary' })
    const rejected = broker
    await credentials.modify('anthropic', async () => ({
      type: 'oauth',
      access: 'relogin',
      refresh: 'new-login',
      expires: Date.now() + 3_600_000,
    }))
    expect((await resolver.resolve(undefined, rejected)).token).toBe('relogin')
    expect(refreshed).toBe(1)
  })

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
})
