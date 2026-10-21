import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'require-parallel.ts')

// Spawn `bun test` in a temp project that preloads our guard, then assert on
// exit code. We use a temp dir rather than the repo's own tests so we control
// the trivial test case (one passing test) and don't run the full 5198-test
// suite per scenario. The preload runs in the spawned process, so its
// process.exit(1) deny is observable as a non-zero parent exit code.

async function makeFixtureProject(
  source = `import { test, expect } from 'bun:test'\ntest('noop', () => expect(1).toBe(1))\n`,
) {
  const dir = await mkdtemp(join(tmpdir(), 'require-parallel-test-'))
  await writeFile(join(dir, 'noop.test.ts'), source)
  // JSON.stringify handles TOML basic-string escaping correctly (the escape
  // sets overlap for `\` and `"`), which lets the test survive contributor
  // checkouts under paths with embedded quotes or backslashes.
  await writeFile(join(dir, 'bunfig.toml'), `[test]\ntimeout = 30000\npreload = [${JSON.stringify(scriptPath)}]\n`)
  return dir
}

async function runBunTest(args: string[], env: Record<string, string> = {}, source?: string) {
  const dir = await makeFixtureProject(source)
  // The parent process running this file is itself `bun test --parallel`, so
  // its env carries BUN_TEST_WORKER_ID (and possibly TYPECLAW_ALLOW_SERIAL_TESTS
  // if the contributor set it). Both would leak into the child subprocess and
  // bypass the guard we're trying to test. Strip them, then layer per-test
  // overrides on top.
  const parentEnv = { ...process.env }
  delete parentEnv.BUN_TEST_WORKER_ID
  delete parentEnv.TYPECLAW_ALLOW_SERIAL_TESTS
  try {
    const proc = Bun.spawn(['bun', 'test', ...args, 'noop.test.ts'], {
      cwd: dir,
      env: { ...parentEnv, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('require-parallel preload', () => {
  test('denies `bun test` without --parallel (exit 1, prints deny message)', async () => {
    const { exitCode, stderr } = await runBunTest([])
    expect(exitCode).toBe(1)
    expect(stderr).toContain('without --parallel is denied')
    expect(stderr).toContain('bun run test')
    expect(stderr).toContain('TYPECLAW_ALLOW_SERIAL_TESTS=1')
  })

  test('allows `bun test --parallel` (exit 0, tests run)', async () => {
    const { exitCode, stderr } = await runBunTest(['--parallel'])
    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('denied in this repo')
  })

  test('TYPECLAW_ALLOW_SERIAL_TESTS=1 bypasses the deny (exit 0, prints warn)', async () => {
    const { exitCode, stderr } = await runBunTest([], { TYPECLAW_ALLOW_SERIAL_TESTS: '1' })
    expect(exitCode).toBe(0)
    expect(stderr).toContain('Running serially')
    expect(stderr).not.toContain('denied in this repo')
  })

  test('TYPECLAW_ALLOW_SERIAL_TESTS=true is not a bypass (only literal "1") — denies', async () => {
    const { exitCode } = await runBunTest([], { TYPECLAW_ALLOW_SERIAL_TESTS: 'true' })
    expect(exitCode).toBe(1)
  })

  test('TYPECLAW_ALLOW_SERIAL_TESTS=0 is not a bypass — denies', async () => {
    const { exitCode } = await runBunTest([], { TYPECLAW_ALLOW_SERIAL_TESTS: '0' })
    expect(exitCode).toBe(1)
  })

  test('--coverage without --parallel still denies (the guard runs before the coverage flag is honored)', async () => {
    const { exitCode } = await runBunTest(['--coverage'])
    expect(exitCode).toBe(1)
  })

  // This integration checks Bun's native child-runner deadline. Fake JS
  // timers cannot drive that watchdog, so the fixture needs real finite work.
  test.each([
    ['25', 1],
    ['10000', 0],
  ] as const)(
    'honors an explicit --timeout %s instead of overwriting it in the preload',
    async (timeout, expectedExit) => {
      const { exitCode } = await runBunTest(
        ['--parallel', '--timeout', timeout],
        {},
        `import { test } from 'bun:test'\ntest('finite async work', async () => { await Bun.sleep(250) })\n`,
      )
      expect(exitCode).toBe(expectedExit)
    },
  )
})
