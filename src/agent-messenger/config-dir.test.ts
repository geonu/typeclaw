import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  agentMessengerConfigDir,
  legacyAgentMessengerConfigDir,
  migrateAgentMessengerConfigDir,
  resolveAgentMessengerConfigPolicy,
} from './config-dir'

describe('resolveAgentMessengerConfigPolicy', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-messenger-policy-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('uses the managed container path and enables migration when the override is absent', () => {
    expect(resolveAgentMessengerConfigPolicy(agentDir)).toEqual({
      override: null,
      containerDir: '/agent/workspace/.config/agent-messenger',
      migrate: true,
    })
  })

  test.each(['/agent/workspace/.config/agent-messenger', 'workspace/.config/agent-messenger'])(
    'treats an explicit managed path as migration-enabled: %s',
    async (value) => {
      await writeFile(join(agentDir, '.env'), `AGENT_MESSENGER_CONFIG_DIR=${value}\n`)

      expect(resolveAgentMessengerConfigPolicy(agentDir)).toEqual({
        override: value,
        containerDir: '/agent/workspace/.config/agent-messenger',
        migrate: true,
      })
    },
  )

  test.each([
    ['/agent/workspace/.agent-messenger', '/agent/workspace/.agent-messenger'],
    ['/operator/custom', '/operator/custom'],
  ])('preserves a non-managed override without migration: %s', async (value, expected) => {
    await writeFile(join(agentDir, '.env'), `AGENT_MESSENGER_CONFIG_DIR=${value}\n`)

    expect(resolveAgentMessengerConfigPolicy(agentDir)).toEqual({
      override: value,
      containerDir: expected,
      migrate: false,
    })
  })

  test('propagates unreadable .env errors instead of defaulting to migration', async () => {
    await symlink(join(agentDir, '.env'), join(agentDir, '.env'))

    expect(() => resolveAgentMessengerConfigPolicy(agentDir)).toThrow()
  })

  // Docker accepts both forms and passes them to the container, so missing them
  // would migrate a legacy store the operator deliberately pinned.
  test.each([
    ['indented', '   AGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger\n'],
    ['tab-indented', '\tAGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger\n'],
    ['BOM-prefixed', '\uFEFFAGENT_MESSENGER_CONFIG_DIR=/agent/workspace/.agent-messenger\n'],
  ])('honors a %s legacy pin and refuses to migrate', async (_label, contents) => {
    await writeFile(join(agentDir, '.env'), contents)

    expect(resolveAgentMessengerConfigPolicy(agentDir)).toEqual({
      override: '/agent/workspace/.agent-messenger',
      containerDir: '/agent/workspace/.agent-messenger',
      migrate: false,
    })
  })
})

describe('migrateAgentMessengerConfigDir', () => {
  let agentDir: string

  beforeEach(async () => {
    agentDir = await mkdtemp(join(tmpdir(), 'typeclaw-agent-messenger-config-'))
  })

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true })
  })

  test('does nothing when the legacy path is missing', async () => {
    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: false })
  })

  test('renames nested credential data intact when the new path is missing', async () => {
    const legacy = legacyAgentMessengerConfigDir(agentDir)
    await mkdir(join(legacy, 'line-storage'), { recursive: true })
    await mkdir(join(legacy, 'instagram', 'alice'), { recursive: true })
    await writeFile(join(legacy, 'line-storage', 'e2ee.key'), 'line-key-material')
    await writeFile(join(legacy, 'instagram', 'alice', 'session.json'), '{"cookies":"session"}')

    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: true })
    expect(existsSync(legacy)).toBe(false)
    expect(await readFile(join(agentMessengerConfigDir(agentDir), 'line-storage', 'e2ee.key'), 'utf8')).toBe(
      'line-key-material',
    )
    expect(await readFile(join(agentMessengerConfigDir(agentDir), 'instagram', 'alice', 'session.json'), 'utf8')).toBe(
      '{"cookies":"session"}',
    )
  })

  test('renames an empty legacy directory when the new path is missing', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: true })
    expect(existsSync(legacyAgentMessengerConfigDir(agentDir))).toBe(false)
    expect(existsSync(agentMessengerConfigDir(agentDir))).toBe(true)
  })

  test('replaces an empty new directory with populated legacy data', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    await writeFile(join(legacyAgentMessengerConfigDir(agentDir), 'session.json'), 'legacy-session')
    await mkdir(agentMessengerConfigDir(agentDir), { recursive: true })

    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: true })
    expect(await readFile(join(agentMessengerConfigDir(agentDir), 'session.json'), 'utf8')).toBe('legacy-session')
  })

  test('removes an empty legacy directory and leaves populated new data untouched', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    await mkdir(agentMessengerConfigDir(agentDir), { recursive: true })
    await writeFile(join(agentMessengerConfigDir(agentDir), 'session.json'), 'new-session')

    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: false })
    expect(existsSync(legacyAgentMessengerConfigDir(agentDir))).toBe(false)
    expect(await readFile(join(agentMessengerConfigDir(agentDir), 'session.json'), 'utf8')).toBe('new-session')
  })

  test('removes an empty legacy directory when both directories are empty', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    await mkdir(agentMessengerConfigDir(agentDir), { recursive: true })
    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: false })
    expect(existsSync(legacyAgentMessengerConfigDir(agentDir))).toBe(false)
    expect(existsSync(agentMessengerConfigDir(agentDir))).toBe(true)
  })

  test('fails without changing either populated tree when both contain data', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    await mkdir(agentMessengerConfigDir(agentDir), { recursive: true })
    await writeFile(join(legacyAgentMessengerConfigDir(agentDir), 'legacy.json'), 'legacy-bytes')
    await writeFile(join(agentMessengerConfigDir(agentDir), 'current.json'), 'current-bytes')

    const result = await migrateAgentMessengerConfigDir(agentDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain(legacyAgentMessengerConfigDir(agentDir))
    expect(result.reason).toContain(agentMessengerConfigDir(agentDir))
    expect(result.reason).toContain('Merge them manually')
    expect(await readFile(join(legacyAgentMessengerConfigDir(agentDir), 'legacy.json'), 'utf8')).toBe('legacy-bytes')
    expect(await readFile(join(agentMessengerConfigDir(agentDir), 'current.json'), 'utf8')).toBe('current-bytes')
  })

  test('rejects a symlinked legacy path without modifying either location', async () => {
    const outside = join(agentDir, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'credential'), 'secret')
    await mkdir(join(agentDir, 'workspace'), { recursive: true })
    await symlink(outside, legacyAgentMessengerConfigDir(agentDir))

    const result = await migrateAgentMessengerConfigDir(agentDir)

    expect(result.ok).toBe(false)
    expect(await readFile(join(outside, 'credential'), 'utf8')).toBe('secret')
    expect(existsSync(agentMessengerConfigDir(agentDir))).toBe(false)
  })

  test('rejects a symlinked destination parent without moving legacy data', async () => {
    const outside = join(agentDir, 'outside')
    const legacy = legacyAgentMessengerConfigDir(agentDir)
    await mkdir(outside)
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'credential'), 'secret')
    await symlink(outside, join(agentDir, 'workspace', '.config'))

    const result = await migrateAgentMessengerConfigDir(agentDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('symbolic link')
    expect(await readFile(join(legacy, 'credential'), 'utf8')).toBe('secret')
    expect(existsSync(join(outside, 'agent-messenger'))).toBe(false)
  })

  // The post-migration steady state has no legacy tree, yet callers still write
  // credentials to the destination — so the parent must be rejected here too.
  test('rejects a symlinked destination parent even when there is nothing to migrate', async () => {
    const outside = join(agentDir, 'outside')
    await mkdir(outside)
    await mkdir(join(agentDir, 'workspace'), { recursive: true })
    await symlink(outside, join(agentDir, 'workspace', '.config'))

    const result = await migrateAgentMessengerConfigDir(agentDir)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('symbolic link')
    expect(existsSync(join(outside, 'agent-messenger'))).toBe(false)
  })

  test('rejects a non-directory new path without modifying legacy data', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    await writeFile(join(legacyAgentMessengerConfigDir(agentDir), 'credential'), 'secret')
    await mkdir(join(agentDir, 'workspace', '.config'), { recursive: true })
    await writeFile(agentMessengerConfigDir(agentDir), 'not-a-directory')

    const result = await migrateAgentMessengerConfigDir(agentDir)

    expect(result.ok).toBe(false)
    expect(await readFile(join(legacyAgentMessengerConfigDir(agentDir), 'credential'), 'utf8')).toBe('secret')
    expect(await readFile(agentMessengerConfigDir(agentDir), 'utf8')).toBe('not-a-directory')
  })

  test('is a clean no-op on the second run', async () => {
    await mkdir(legacyAgentMessengerConfigDir(agentDir), { recursive: true })
    await writeFile(join(legacyAgentMessengerConfigDir(agentDir), 'session.json'), 'session')
    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: true })
    expect(await migrateAgentMessengerConfigDir(agentDir)).toEqual({ ok: true, migrated: false })
  })
})
