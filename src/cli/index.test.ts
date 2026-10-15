import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isWindows } from '@/shared'

import { BUILTIN_COMMAND_NAMES } from './builtins'

const REPO_ROOT = resolvePath(import.meta.dir, '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts')
const PLUGIN_IMPORT = pathToFileURL(join(REPO_ROOT, 'src', 'plugin', 'index.ts')).href
const onWindows = isWindows()
const tmpDirs: string[] = []

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })))
})

async function mkAgent(pluginText?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tccli-'))
  tmpDirs.push(dir)
  await symlink(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')
  const config: { plugins?: string[] } = {}
  if (pluginText !== undefined) {
    await writeFile(join(dir, 'plugin.ts'), pluginText, 'utf8')
    config.plugins = ['./plugin.ts']
  }
  await writeFile(join(dir, 'typeclaw.json'), JSON.stringify(config, null, 2), 'utf8')
  return dir
}

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, TYPECLAW_TEST: '1' },
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { stdout, stderr, code }
}

const ECHO_PLUGIN = `
import { definePlugin, defineCommand } from '${PLUGIN_IMPORT}'
import { z } from 'zod'

export default definePlugin({
  commands: {
    'echo-host': defineCommand({
      surface: 'host',
      description: 'echo a message',
      args: z.object({ msg: z.string() }),
      run: async (ctx, args) => {
        const writer = ctx.stdout.getWriter()
        await writer.write(new TextEncoder().encode(\`got: \${args.msg}\\n\`))
        writer.releaseLock()
        return 0
      },
    }),
  },
  plugin: async () => ({}),
})
`

// Serial, NOT `.concurrent`: each test spawns a fresh `bun run src/cli/index.ts`
// that re-transpiles the whole CLI module graph. `.concurrent` fired all ~16
// spawns at once on an already-saturated `--parallel` worker pool, so they
// raced the 30s timeout under contention (the recurring "timed out after
// 30000ms" flake). Serial bounds the file to one in-flight subprocess. Don't
// restore `.concurrent` or bump the timeout — both only hide the spawn storm.
// Windows skips the POSIX shell plugin-command shim, #899.
const pluginCommandTest = onWindows ? test.skip : test

describe('typeclaw <plugin-command> on host stage', () => {
  pluginCommandTest('QA-5 end-to-end: dispatches a host command via CLI entrypoint', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stdout, code } = await runCli(['echo-host', '--msg=hello'], dir)
    expect(code).toBe(0)
    expect(stdout).toContain('got: hello')
  })

  pluginCommandTest('exits 2 with stderr message when required arg is missing', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stderr, code } = await runCli(['echo-host'], dir)
    expect(code).toBe(2)
    expect(stderr).toMatch(/msg/i)
  })

  test('unknown command falls through to citty (no plugin match, no built-in)', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { code } = await runCli(['no-such-command'], dir)
    expect(code).not.toBe(0)
  })
})

describe('typeclaw --help on host stage', () => {
  pluginCommandTest('QA-16: appends a Plugin commands section listing discovered commands', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stdout, code } = await runCli(['--help'], dir)
    expect(code).toBe(0)
    expect(stdout).toContain('Plugin commands:')
    expect(stdout).toContain('echo-host')
    expect(stdout).toContain('echo a message')
  })

  test('QA-17: outside an agent folder, no Plugin commands section is shown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tccli-bare-'))
    tmpDirs.push(dir)
    const { stdout, code } = await runCli(['--help'], dir)
    expect(code).toBe(0)
    expect(stdout).not.toContain('Plugin commands:')
  })
})

describe('typeclaw update on host stage', () => {
  test('dry-run prints the selected updater command without hitting the registry', async () => {
    const dir = await mkAgent()
    const { stdout, stderr, code } = await runCli(['update', '--manager=bun', '--dry-run'], dir)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('bun update -g typeclaw --latest')
  })

  test('dry-run renders the pnpm command when --manager=pnpm', async () => {
    const dir = await mkAgent()
    const { stdout, stderr, code } = await runCli(['update', '--manager=pnpm', '--dry-run'], dir)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('pnpm add -g typeclaw@latest')
  })

  test('dry-run renders the yarn command when --manager=yarn', async () => {
    const dir = await mkAgent()
    const { stdout, stderr, code } = await runCli(['update', '--manager=yarn', '--dry-run'], dir)
    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout.trim()).toBe('yarn global upgrade typeclaw --latest')
  })

  test('rejects unknown --manager values with exit code 2', async () => {
    const dir = await mkAgent()
    const { stderr, code } = await runCli(['update', '--manager=cargo', '--dry-run'], dir)
    expect(code).toBe(2)
    expect(stderr).toContain('Invalid --manager=cargo')
  })

  test('auto mode refuses a source checkout because it cannot prove the global manager', async () => {
    const dir = await mkAgent()
    const { stderr, code } = await runCli(['update', '--dry-run'], dir)
    expect(code).toBe(1)
    expect(stderr).toContain('Cannot auto-detect how TypeClaw was installed')
  })
})

describe('top-level usage (hand-rendered, no subcommand modules imported)', () => {
  test('no args: prints the usage table to stdout, "No command specified." to stderr, exits 1', async () => {
    const dir = await mkAgent()
    const { stdout, stderr, code } = await runCli([], dir)
    expect(code).toBe(1)
    expect(stdout).toContain('USAGE')
    expect(stdout).toContain('COMMANDS')
    expect(stdout).toContain('init')
    expect(stdout).toContain('update')
    expect(stdout).toContain('Use ')
    expect(stderr.trim()).toBe('No command specified.')
  })

  pluginCommandTest('no args: does NOT discover plugin commands even in an agent that declares one', async () => {
    const dir = await mkAgent(ECHO_PLUGIN)
    const { stdout, code } = await runCli([], dir)
    expect(code).toBe(1)
    expect(stdout).not.toContain('Plugin commands:')
    expect(stdout).not.toContain('echo-host')
  })

  test('--help and -h produce identical output and exit 0', async () => {
    const dir = await mkAgent()
    const [long, short] = await Promise.all([runCli(['--help'], dir), runCli(['-h'], dir)])
    expect(long.code).toBe(0)
    expect(short.code).toBe(0)
    expect(short.stdout).toBe(long.stdout)
    expect(long.stdout).toContain('USAGE')
    expect(long.stdout).toContain('COMMANDS')
  })

  test('usage table hides the internal _hostd / _update-check commands', async () => {
    const dir = await mkAgent()
    const { stdout } = await runCli(['--help'], dir)
    expect(stdout).not.toContain('_hostd')
    expect(stdout).not.toContain('_update-check')
  })

  test('--version stays handled by citty: prints the version and exits 0', async () => {
    const dir = await mkAgent()
    const { stdout, code } = await runCli(['--version'], dir)
    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('_hostd preservation', () => {
  test('_hostd is recognized as a built-in (not routed to plugin dispatcher)', async () => {
    // We can't actually launch _hostd in a test (it would daemonize), but
    // we can verify it appears in `typeclaw --help` (citty subCommand) and
    // is in BUILTIN_COMMAND_NAMES so the intercept skips it.
    expect(BUILTIN_COMMAND_NAMES).toContain('_hostd')
    const dir = await mkAgent()
    const { stdout } = await runCli(['--help'], dir)
    // citty's help is the source; we just need to verify it ran (exit 0
    // with non-empty stdout would mean citty's runMain didn't bail).
    expect(stdout.length).toBeGreaterThan(0)
  })
})
