import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { hydrateChannelEnvFromSecrets } from './hydrate'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'typeclaw-hydrate-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeSecretsV2(file: {
  channels?: Record<string, Record<string, unknown>>
  providers?: Record<string, unknown>
}): void {
  writeFileSync(
    join(root, 'secrets.json'),
    JSON.stringify({ version: 2, providers: file.providers ?? {}, channels: file.channels ?? {} }),
  )
}

describe('hydrateChannelEnvFromSecrets', () => {
  test('injects each per-adapter field into env using the default env-var name', () => {
    writeSecretsV2({
      channels: {
        'discord-bot': { token: 'd-tok' },
        'slack-bot': { botToken: 'xoxb-a', appToken: 'xapp-b' },
      },
    })
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBe('d-tok')
    expect(env['SLACK_BOT_TOKEN']).toBe('xoxb-a')
    expect(env['SLACK_APP_TOKEN']).toBe('xapp-b')
    expect(result.applied.sort()).toEqual(['DISCORD_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
  })

  test('injects webex-bot.token into WEBEX_BOT_TOKEN', () => {
    writeSecretsV2({ channels: { 'webex-bot': { token: 'webex-tok' } } })
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['WEBEX_BOT_TOKEN']).toBe('webex-tok')
    expect(result.applied).toEqual(['WEBEX_BOT_TOKEN'])
  })

  test('env wins: existing env value is preserved and file value is skipped', () => {
    writeSecretsV2({ channels: { 'discord-bot': { token: 'from-secrets' } } })
    const env: NodeJS.ProcessEnv = { DISCORD_BOT_TOKEN: 'from-env-file' }

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBe('from-env-file')
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual(['DISCORD_BOT_TOKEN'])
  })

  test('does NOT strip .env after applying (the legacy auto-strip is gone)', () => {
    writeSecretsV2({ channels: { 'discord-bot': { token: 'd-tok' } } })
    writeFileSync(join(root, '.env'), 'FIREWORKS_API_KEY=keep\nDISCORD_BOT_TOKEN=stale\n')
    const env: NodeJS.ProcessEnv = {}

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    const after = readFileSync(join(root, '.env'), 'utf8')
    expect(after).toBe('FIREWORKS_API_KEY=keep\nDISCORD_BOT_TOKEN=stale\n')
  })

  test('object Secret with explicit env field is honored', () => {
    writeSecretsV2({
      channels: {
        'discord-bot': { token: { value: 'd-disk', env: 'CUSTOM_DISCORD_TOKEN' } },
      },
    })
    const env: NodeJS.ProcessEnv = { CUSTOM_DISCORD_TOKEN: 'd-custom' }

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBe('d-custom')
  })

  test('object Secret with only env field and env unset falls back to nothing (no injection)', () => {
    writeSecretsV2({
      channels: {
        'discord-bot': { token: { env: 'NOT_SET' } },
      },
    })
    const env: NodeJS.ProcessEnv = {}

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(env['DISCORD_BOT_TOKEN']).toBeUndefined()
  })

  test('returns empty result when secrets.json does not exist', () => {
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(result.applied).toEqual([])
    expect(env['DISCORD_BOT_TOKEN']).toBeUndefined()
  })

  test('returns empty result when secrets.json#channels is empty', () => {
    writeSecretsV2({ channels: {} })
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(result.applied).toEqual([])
  })

  test('ignores malformed secrets.json rather than throwing', () => {
    writeFileSync(join(root, 'secrets.json'), '{ not json')
    const env: NodeJS.ProcessEnv = {}

    expect(() => hydrateChannelEnvFromSecrets({ agentDir: root, env })).not.toThrow()
  })

  test('skips unknown adapter ids (forward-compat for plugin adapters)', () => {
    writeSecretsV2({ channels: { 'future-plugin-adapter': { token: 'pt' } } })
    const env: NodeJS.ProcessEnv = {}

    const result = hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(result.applied).toEqual([])
  })

  test('does not exist: .env file is never written by hydrate', () => {
    writeSecretsV2({ channels: { 'discord-bot': { token: 'd-tok' } } })
    const env: NodeJS.ProcessEnv = {}

    hydrateChannelEnvFromSecrets({ agentDir: root, env })

    expect(existsSync(join(root, '.env'))).toBe(false)
  })
})
