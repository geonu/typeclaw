import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { clearSingletonLocks, type SandboxEntryConfig, writeDownloadPreference } from './sandbox-entry'

async function config(): Promise<SandboxEntryConfig> {
  const root = await mkdtemp(join(tmpdir(), 'sandbox-entry-'))
  return {
    chrome: '/bin/false',
    runDir: join(root, 'run'),
    profileDir: join(root, 'profile'),
    downloadsDir: join(root, 'files'),
    extensionDirs: [],
    headless: true,
  }
}

describe('persistent profile', () => {
  test('download preference merges into existing Preferences instead of replacing them', async () => {
    // given
    const cfg = await config()
    await mkdir(join(cfg.profileDir, 'Default'), { recursive: true })
    await writeFile(
      join(cfg.profileDir, 'Default', 'Preferences'),
      JSON.stringify({ profile: { name: 'kept' }, download: { directory_upgrade: true } }),
    )

    // when
    await writeDownloadPreference(cfg)

    // then
    const prefs = JSON.parse(await readFile(join(cfg.profileDir, 'Default', 'Preferences'), 'utf8'))
    expect(prefs.profile).toEqual({ name: 'kept' })
    expect(prefs.download).toEqual({
      directory_upgrade: true,
      default_directory: cfg.downloadsDir,
      prompt_for_download: false,
    })
    expect(prefs.savefile).toEqual({ default_directory: cfg.downloadsDir })
  })

  for (const [label, content] of [
    ['truncated JSON', '{"profile": {"na'],
    ['a non-object root', '[1, 2]'],
    ['a null root', 'null'],
  ] as const) {
    test(`malformed Preferences (${label}) is set aside and Chrome still gets a valid file`, async () => {
      // given
      const cfg = await config()
      const prefsDir = join(cfg.profileDir, 'Default')
      await mkdir(prefsDir, { recursive: true })
      await writeFile(join(prefsDir, 'Preferences'), content)

      // when
      await writeDownloadPreference(cfg)

      // then
      const prefs = JSON.parse(await readFile(join(prefsDir, 'Preferences'), 'utf8'))
      expect(prefs.download.default_directory).toBe(cfg.downloadsDir)
      const entries = await readdir(prefsDir)
      const corrupt = entries.filter((name) => name.startsWith('Preferences.corrupt-'))
      expect(corrupt).toHaveLength(1)
      expect(await readFile(join(prefsDir, corrupt[0]!), 'utf8')).toBe(content)
      expect(entries).not.toContain('Preferences.typeclaw-tmp')
    })
  }

  test('download preference is written on a fresh profile', async () => {
    const cfg = await config()
    await writeDownloadPreference(cfg)
    const prefs = JSON.parse(await readFile(join(cfg.profileDir, 'Default', 'Preferences'), 'utf8'))
    expect(prefs.download.default_directory).toBe(cfg.downloadsDir)
  })

  test('stale singleton locks from a previous container are removed, profile data kept', async () => {
    // given
    const cfg = await config()
    await mkdir(join(cfg.profileDir, 'Default'), { recursive: true })
    await symlink('old-host-123', join(cfg.profileDir, 'SingletonLock'))
    await symlink('/tmp/gone', join(cfg.profileDir, 'SingletonSocket'))
    await symlink('42', join(cfg.profileDir, 'SingletonCookie'))
    await writeFile(join(cfg.profileDir, 'Default', 'Cookies'), 'cookies')

    // when
    await clearSingletonLocks(cfg.profileDir)

    // then
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      expect(existsSync(join(cfg.profileDir, name))).toBe(false)
    }
    expect(await readFile(join(cfg.profileDir, 'Default', 'Cookies'), 'utf8')).toBe('cookies')
  })
})
