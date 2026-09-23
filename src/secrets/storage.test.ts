import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import { SecretsBackend } from './storage'

const onWindows = isWindows()

describe('SecretsBackend CredentialStore', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-secrets-'))
    path = join(dir, 'secrets.json')
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  test('preserves untouched Secret bytes and channels while modifying another credential', async () => {
    const backend = new SecretsBackend(path)
    backend.writeProviderCredentialSync('fireworks', { type: 'api_key', key: { value: 'disk', env: 'CUSTOM_KEY' } })
    backend.writeChannelsSync({ 'discord-bot': { token: { value: 'keep' } } })
    await backend.modify('openai', async () => ({ type: 'api_key', key: 'new-key' }))
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    expect(parsed.providers.fireworks).toEqual({ type: 'api_key', key: { value: 'disk', env: 'CUSTOM_KEY' } })
    expect(parsed.providers.openai).toEqual({ type: 'api_key', key: { value: 'new-key' } })
    expect(parsed.channels).toEqual({ 'discord-bot': { token: { value: 'keep' } } })
  })

  test('empty API-key mutation is a no-op', async () => {
    const backend = new SecretsBackend(path)
    backend.writeProviderCredentialSync('openai', { type: 'api_key', key: { value: 'keep' } })
    await backend.modify('openai', async () => ({ type: 'api_key', key: '' }))
    expect(await backend.read('openai')).toEqual({ type: 'api_key', key: 'keep' })
  })

  test('serializes concurrent provider mutations', async () => {
    const backend = new SecretsBackend(path)
    await Promise.all([
      backend.modify('openai', async () => ({ type: 'api_key', key: 'one' })),
      backend.modify('fireworks', async () => ({ type: 'api_key', key: 'two' })),
    ])
    expect(await backend.read('openai')).toEqual({ type: 'api_key', key: 'one' })
    expect(await backend.read('fireworks')).toEqual({ type: 'api_key', key: 'two' })
  })

  test('returns complete snapshots while a writer holds the provider lock', async () => {
    const backend = new SecretsBackend(path)
    await backend.modify('openai', async () => ({ type: 'api_key', key: 'old' }))
    await mkdir(`${path}.lock`)

    const snapshot = Promise.all([backend.read('openai'), backend.list()])
    try {
      // A snapshot read must not wait for a writer's lock. With the old locked
      // reader, this remains pending while proper-lockfile retries. Yield a
      // bounded number of microtasks so immediately resolved snapshots settle.
      let settled = false
      void snapshot.then(() => {
        settled = true
      })
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(settled).toBe(true)
      expect(await snapshot).toEqual([{ type: 'api_key', key: 'old' }, [{ providerId: 'openai', type: 'api_key' }]])
    } finally {
      await rm(`${path}.lock`, { recursive: true, force: true })
      await snapshot
    }
  })
})

describe('v2 credential envelope regressions', () => {
  let dir: string
  let path: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'typeclaw-storage-'))
    path = join(dir, 'secrets.json')
  })
  afterEach(async () => rm(dir, { recursive: true, force: true }))

  test('first modify creates parseable v2 envelope with 0600 mode', async () => {
    const store = new SecretsBackend(path)
    await store.modify('openai', async () => ({ type: 'api_key', key: 'key' }))
    const file = JSON.parse(await readFile(path, 'utf8'))
    expect(file).toMatchObject({
      version: 2,
      providers: { openai: { type: 'api_key', key: { value: 'key' } } },
      channels: {},
      mcp: {},
    })
    // NTFS mode bits are not meaningful on Windows; see #899.
    if (!onWindows) expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test('storage failures reject rather than silently recording an internal error', async () => {
    await writeFile(path, '{invalid')
    await expect(new SecretsBackend(path).read('openai')).rejects.toThrow('not valid JSON')
  })

  test('preserves GitHub CLI, MCP, channels, and unknown top-level slices', async () => {
    const store = new SecretsBackend(path)
    store.writeGithubCliSync({ hosts: 'host-store' })
    store.writeMcpCredentialSync('linear', { tokens: { access_token: 'token' } })
    store.writeChannelsSync({ 'discord-bot': { token: { value: 'channel' } } })
    await store.modify('openai', async () => ({ type: 'api_key', key: 'key' }))
    const file = JSON.parse(await readFile(path, 'utf8'))
    expect(file.githubCli).toEqual({ hosts: 'host-store' })
    expect(file.mcp.linear).toEqual({ tokens: { access_token: 'token' } })
    expect(file.channels['discord-bot']).toEqual({ token: { value: 'channel' } })
  })

  test('preserves env-bound Secret for an OAuth write and retains env when key changes', async () => {
    const store = new SecretsBackend(path)
    store.writeProviderCredentialSync('fireworks', { type: 'api_key', key: { value: 'old', env: 'CUSTOM' } })
    await store.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: Date.now() + 60000,
    }))
    await store.modify('fireworks', async () => ({ type: 'api_key', key: 'new' }))
    const file = JSON.parse(await readFile(path, 'utf8'))
    expect(file.providers.fireworks).toEqual({ type: 'api_key', key: { value: 'new', env: 'CUSTOM' } })
  })

  test('delete removes only the requested provider and channel removal stays idempotent', async () => {
    const store = new SecretsBackend(path)
    store.writeProviderCredentialSync('openai', { type: 'api_key', key: { value: 'one' } })
    store.writeProviderCredentialSync('fireworks', { type: 'api_key', key: { value: 'two' } })
    store.writeChannelsSync({ 'discord-bot': { token: { value: 'token' } } })
    await store.delete('openai')
    expect(store.removeChannelSync('discord-bot')).toBe(true)
    expect(store.removeChannelSync('discord-bot')).toBe(false)
    expect(await store.read('openai')).toBeUndefined()
    expect(await store.read('fireworks')).toEqual({ type: 'api_key', key: 'two' })
  })
  test('concurrent store instances retain both independent credential writes', async () => {
    const left = new SecretsBackend(path)
    const right = new SecretsBackend(path)
    await Promise.all([
      left.modify('openai', async () => ({ type: 'api_key', key: 'left' })),
      right.modify('fireworks', async () => ({ type: 'api_key', key: 'right' })),
    ])
    expect(await left.read('openai')).toEqual({ type: 'api_key', key: 'left' })
    expect(await right.read('fireworks')).toEqual({ type: 'api_key', key: 'right' })
  })

  test('preserves unknown top-level data through a credential mutation', async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 2, providers: {}, channels: {}, mcp: {}, futureSlice: { preserve: true } }),
    )
    await new SecretsBackend(path).modify('openai', async () => ({ type: 'api_key', key: 'key' }))
    expect(JSON.parse(await readFile(path, 'utf8')).futureSlice).toEqual({ preserve: true })
  })
  test('updates and removes MCP credentials without disturbing sibling slices', async () => {
    const store = new SecretsBackend(path)
    store.writeProviderCredentialSync('openai', { type: 'api_key', key: { value: 'provider' } })
    store.writeMcpCredentialSync('first', { tokens: { access_token: 'first' } })
    store.writeMcpCredentialSync('second', { tokens: { access_token: 'second' } })
    await store.updateMcpAsync(async (current) => ({
      result: undefined,
      next: { ...current, first: { tokens: { access_token: 'rotated' } } },
    }))
    expect(store.removeMcpCredentialSync('second')).toBe(true)
    expect(store.tryReadMcpSync()).toEqual({ first: { tokens: { access_token: 'rotated' } } })
    expect(await store.read('openai')).toEqual({ type: 'api_key', key: 'provider' })
  })

  test('active canonical env cannot rewrite an untouched API-key Secret during another provider mutation', async () => {
    const previous = process.env.FIREWORKS_API_KEY
    process.env.FIREWORKS_API_KEY = 'runtime-only'
    try {
      const store = new SecretsBackend(path)
      store.writeProviderCredentialSync('fireworks', { type: 'api_key', key: { value: 'disk', env: 'CUSTOM_KEY' } })
      await store.modify('openai-codex', async () => ({
        type: 'oauth',
        access: 'access',
        refresh: 'refresh',
        expires: Date.now() + 60_000,
      }))
      const stored = JSON.parse(await readFile(path, 'utf8')).providers.fireworks
      expect(stored).toEqual({ type: 'api_key', key: { value: 'disk', env: 'CUSTOM_KEY' } })
    } finally {
      if (previous === undefined) delete process.env.FIREWORKS_API_KEY
      else process.env.FIREWORKS_API_KEY = previous
    }
  })
})
