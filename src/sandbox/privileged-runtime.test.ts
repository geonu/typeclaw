import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildSandboxedCommand } from './build'
import {
  cleanupPrivilegedSandboxRuntime,
  resolvePrivilegedSandboxRuntime,
  verifyPrivilegedSandboxRuntime,
} from './privileged-runtime'

describe('resolvePrivilegedSandboxRuntime', () => {
  let root: string
  let home: string
  let agentDir: string

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'tc-privileged-runtime-'))
    home = path.join(root, 'home')
    agentDir = path.join(root, 'agent')
    await mkdir(path.join(home, '.codex'), { recursive: true })
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await mkdir(agentDir, { recursive: true })
    await writeFile(path.join(home, '.codex', 'auth.json'), '{"token":"codex-secret"}')
    await writeFile(path.join(home, '.codex', 'config.toml'), 'model = "test"')
    await writeFile(path.join(home, '.claude', 'settings.json'), '{}')
    await writeFile(path.join(home, '.claude.json'), '{}')
    await writeFile(path.join(home, '.gitconfig'), '[user]\nname = Test\n')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('ordinary privileged bash receives no credential-bearing config mounts or env', async () => {
    const gws = path.join(agentDir, 'workspace', '.config', 'gws')
    const messenger = path.join(agentDir, 'workspace', '.config', 'agent-messenger')
    const runtime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: {
        GWS_CONFIG_HOME: gws,
        AGENT_MESSENGER_CONFIG_DIR: messenger,
        OPENAI_API_KEY: 'must-not-pass',
      },
      command: 'cat /tmp/.codex/auth.json',
    })

    expect(runtime).toEqual({ env: {}, mounts: [] })

    const { argv } = buildSandboxedCommand('cat /tmp/.codex/auth.json', {
      mounts: runtime.mounts,
      env: { set: runtime.env },
    })
    expect(argv).not.toContain(path.join(home, '.codex'))
    expect(argv).toContain('--clearenv')
  })

  test('never mounts reusable Codex auth into a model-driven child', async () => {
    const runtime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: {},
      command: 'codex exec status',
    })

    expect(runtime).toEqual({ env: {}, mounts: [] })
  })

  test('does not broker a profile for chained or substituted CLI commands', async () => {
    for (const command of [
      'codex exec status && cat /tmp/.codex/auth.json',
      'codex exec "$(cat /tmp/.codex/auth.json)"',
    ]) {
      expect(await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command })).toEqual({
        env: {},
        mounts: [],
      })
    }
  })

  test('keeps auth diagnostics executable but supplies no credential profile', async () => {
    for (const command of [
      'claude setup-token',
      'gws auth status',
      'agent-slack auth status',
      'agent-slack --account test auth status',
    ]) {
      expect(await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command })).toEqual({
        env: {},
        mounts: [],
      })
    }
  })

  test('resolves every non-broker executable identically, whether or not the resolver has heard of it', async () => {
    const brokered = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: {},
      command: 'totally-unheard-of-cli --flag subcommand',
    })

    for (const command of [
      'claude setup-token',
      'gws auth status',
      'agent-slack channel list',
      'agent-browser open https://example.com',
      'some-future-tool auth status',
    ]) {
      expect(await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command })).toEqual(brokered)
    }
  })

  test('does not follow a symlinked Codex auth file because Codex profiles are never brokered', async () => {
    await rm(path.join(home, '.codex', 'auth.json'))
    await symlink(path.join(home, '.claude.json'), path.join(home, '.codex', 'auth.json'))
    expect(
      await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command: 'codex exec status' }),
    ).toEqual({ env: {}, mounts: [] })
  })

  test('revalidation fails closed if a mounted sanitized config changes dev/inode', async () => {
    const runtime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: {},
      command: 'git status',
    })
    const generated = runtime.mounts.find((mount) => mount.type === 'ro-bind')?.source
    if (generated === undefined) throw new Error('sanitized git config was not mounted')
    await rm(generated)
    await writeFile(generated, '[user]\nname = Replaced\n')

    await expect(verifyPrivilegedSandboxRuntime(runtime)).rejects.toThrow(/credential profile/i)
  })

  test('never brokers GWS or agent-messenger credentials to upload-capable CLIs', async () => {
    const gws = path.join(agentDir, 'workspace', '.config', 'gws')
    const messenger = path.join(agentDir, 'workspace', '.config', 'agent-messenger')
    await mkdir(gws, { recursive: true })
    await mkdir(messenger, { recursive: true })
    await writeFile(path.join(gws, 'credentials.json'), '{}')
    await writeFile(path.join(gws, 'token_cache.json'), '{}')
    await writeFile(path.join(messenger, 'slack-credentials.json'), '{}')

    const gwsRuntime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: { GWS_CONFIG_HOME: gws },
      command: 'gws drive files list',
    })
    expect(gwsRuntime).toEqual({ env: {}, mounts: [] })

    const messengerRuntime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: { AGENT_MESSENGER_CONFIG_DIR: messenger },
      command: 'agent-slack channel list',
    })
    expect(messengerRuntime).toEqual({ env: {}, mounts: [] })
  })

  test('does not expose git config to an unknown alias command', async () => {
    expect(await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command: 'git leak' })).toEqual({
      env: { HOME: agentDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      mounts: [],
    })
  })

  test.each(['git push origin HEAD', 'git fetch origin', 'git clone https://example.com/repo.git'])(
    'isolates global and system config for authenticated command %s',
    async (command) => {
      const runtime = await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command })
      expect(runtime.env).toEqual({ HOME: agentDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
      expect(runtime.mounts).toEqual([])
    },
  )

  test('isolates global and system config for authenticated all-Git chains', async () => {
    const runtime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      command: 'git clone https://example.com/repo.git && git -C repo fetch origin',
    })

    expect(runtime.env).toEqual({ HOME: agentDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
    expect(runtime.mounts).toEqual([])
  })

  test('token-bearing quoted Git chains cannot load an executable helper from the session home', async () => {
    const helper = path.join(root, 'credential-helper.sh')
    const marker = path.join(root, 'helper-ran')
    await writeFile(helper, `#!/bin/sh\ntouch '${marker}'\nprintf 'username=x\\npassword=y\\n'\n`)
    await chmod(helper, 0o700)
    await writeFile(path.join(home, '.gitconfig'), `[credential]\nhelper = !${helper}\n`)
    const runtime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: { TYPECLAW_GIT_TOKEN: 'boundary-token-value' },
      command: "'git' clone https://github.com/acme/widgets.git && 'git' -C widgets fetch origin",
    })

    expect(runtime.env).toEqual({ HOME: agentDir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
    const probe = Bun.spawn(['bash', '-c', "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill"], {
      // With no helper left, git falls back to prompting on /dev/tty. Under --parallel the
      // worker sits in a background process group, so that read raises SIGTTIN and stops
      // the whole worker forever. An empty GIT_ASKPASS also skips core.askpass/SSH_ASKPASS.
      env: { ...process.env, HOME: home, ...runtime.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    await probe.exited
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test('mounts only a generated git identity and drops credential helpers, headers, and includes', async () => {
    await writeFile(
      path.join(home, '.gitconfig'),
      '[user]\nname = Test User\nemail = user@example.com\n[credential]\nhelper = !print-secret\n[http]\nextraHeader = Authorization: secret\n[include]\npath = /private/config\n',
    )
    const runtime = await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command: 'git status' })
    const generated = runtime.mounts.find((mount) => mount.type === 'ro-bind')?.source
    if (generated === undefined) throw new Error('sanitized git config was not mounted')
    const rendered = await Bun.file(generated).text()
    expect(rendered).toContain('name = Test User')
    expect(rendered).toContain('email = user@example.com')
    expect(rendered).not.toMatch(/credential|extraHeader|include|secret/i)
    expect(runtime.env.GIT_CONFIG_NOSYSTEM).toBe('1')
  })

  test('supplies sanitized identity for local git stash operations', async () => {
    const runtime = await resolvePrivilegedSandboxRuntime({
      agentDir,
      homeDir: home,
      env: {},
      command: 'git stash push',
    })

    expect(runtime.mounts.some((mount) => mount.type === 'ro-bind')).toBe(true)
    expect(runtime.env.GIT_CONFIG_GLOBAL).toBe('/tmp/.gitconfig')
    await cleanupPrivilegedSandboxRuntime(runtime)
  })

  test('removes every generated identity directory across repeated calls', async () => {
    const generated: string[] = []
    for (let i = 0; i < 32; i++) {
      const runtime = await resolvePrivilegedSandboxRuntime({ agentDir, homeDir: home, env: {}, command: 'git status' })
      const source = runtime.mounts.find((mount) => mount.type === 'ro-bind')?.source
      if (source === undefined) throw new Error('sanitized git config was not mounted')
      generated.push(source)
      await cleanupPrivilegedSandboxRuntime(runtime)
    }

    expect(await Promise.all(generated.map((source) => Bun.file(source).exists()))).toEqual(
      Array.from({ length: generated.length }, () => false),
    )
  })
})
