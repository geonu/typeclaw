import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sessionRowLabel } from './inspect'
import { createTailScope } from './inspect-controller'

const CLI_ENTRY = join(import.meta.dir, 'index.ts')

test('registry-only session rows say live without claiming a reply is in flight', () => {
  const label = sessionRowLabel({
    sessionId: '0192abcd-1111-7000-8000-000000000001',
    sessionFile: '',
    basename: '',
    mtimeMs: 1,
    origin: { kind: 'tui' },
    firstPrompt: null,
    live: true,
  })

  expect(label).toContain('live')
  expect(label).not.toContain('replying')
})

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

class FakeTty extends EventEmitter {
  isTTY = true as const
  rawMode = false
  resumed = false
  pauseCalls = 0
  setRawMode(value: boolean): this {
    this.rawMode = value
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.pauseCalls += 1
    this.resumed = false
    return this
  }
  feed(bytes: number[]): void {
    this.emit('data', Buffer.from(bytes))
  }
}

class FakeProc extends EventEmitter {
  fire(signal: string): void {
    this.emit(signal)
  }
}

describe('createTailScope wiring', () => {
  test('arms raw mode and attaches a data handler on a TTY', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    expect(tty.rawMode).toBe(true)
    expect(tty.resumed).toBe(true)
    expect(tty.listenerCount('data')).toBe(1)
    scope.dispose()
  })

  test('Ctrl-C byte aborts with exit intent', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    tty.feed([0x03])
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('exit')
    scope.dispose()
  })

  test('bare ESC aborts with back intent after the idle window', async () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: proc as never })
    tty.feed([0x1b])
    expect(scope.signal.aborted).toBe(false)
    await tick(600)
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('back')
    scope.dispose()
  })

  test('arrow-key CSI sequence does not abort', async () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 10, input: tty as never, proc: proc as never })
    tty.feed([0x1b])
    tty.feed([0x5b, 0x41])
    await tick(30)
    expect(scope.signal.aborted).toBe(false)
    expect(scope.intent()).toBeNull()
    scope.dispose()
  })

  test('SIGINT aborts with exit intent', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    proc.fire('SIGINT')
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('exit')
    scope.dispose()
  })

  test('dispose restores raw mode and detaches handlers without pausing stdin', () => {
    // The next clack picker must inherit a non-raw, still-flowing stdin: a paused
    // process.stdin does not reliably re-flow under Bun, which is what froze the
    // picker. Detaching our data handler and clearing raw mode lets clack own it.
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    expect(tty.listenerCount('data')).toBe(1)
    scope.dispose()
    expect(tty.rawMode).toBe(false)
    expect(tty.listenerCount('data')).toBe(0)
    expect(tty.pauseCalls).toBe(0)
    expect(proc.listenerCount('SIGINT')).toBe(0)
    expect(proc.listenerCount('SIGTERM')).toBe(0)
  })

  test('dispose is idempotent', () => {
    const tty = new FakeTty()
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    scope.dispose()
    scope.dispose()
    expect(tty.listenerCount('data')).toBe(0)
  })

  test('non-TTY input never touches raw mode but still aborts on signals', () => {
    const tty = new FakeTty()
    tty.isTTY = false as unknown as true
    const proc = new FakeProc()
    const scope = createTailScope({ debounceMs: 50, input: tty as never, proc: proc as never })
    expect(tty.listenerCount('data')).toBe(0)
    proc.fire('SIGTERM')
    expect(scope.signal.aborted).toBe(true)
    expect(scope.intent()).toBe('exit')
    scope.dispose()
  })
})

describe('typeclaw inspect refuses a non-agent folder', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-inspect-noagent-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('exits 1 with a config-not-found error instead of the degraded picker', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'inspect'],
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited

    expect(exitCode).toBe(1)
    expect(stderr).toMatch(/config file not found/)
    expect(stdout).not.toContain('Pick what to view')
    expect(stderr).not.toContain('container not running')
  })
})

describe('typeclaw inspect refuses the picker without a TTY', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-inspect-notty-'))
    await writeFile(join(cwd, 'typeclaw.json'), JSON.stringify({}), 'utf8')
    await mkdir(join(cwd, 'sessions'), { recursive: true })
    // A listable session so the loop would otherwise open the clack picker; the
    // id is >=8 chars and isSessionIdShape-valid so `inspect <id>` resolves it.
    const sessionId = '0192abcd-1111-7000-8000-000000000001'
    await writeFile(
      join(cwd, 'sessions', `2026-07-22T00-00-00_${sessionId}.jsonl`),
      `${JSON.stringify({ cat: 'meta', ts: 1, origin: { kind: 'tui' } })}\n`,
      'utf8',
    )
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  // Reproduces the 100%-CPU busy-spin: with a piped (non-TTY) stdin the clack
  // picker never resolves and spins kevent64 forever. The guard must exit fast
  // with a hint instead of hanging, so `stdin: 'ignore'` (a non-TTY) is the crux.
  test('exits 2 with a use-a-session-id hint instead of spinning on the picker', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'inspect'],
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited

    expect(exitCode).toBe(2)
    expect(stderr).toMatch(/needs an interactive terminal/)
    expect(stderr).toMatch(/typeclaw inspect <id>/)
    expect(stdout).not.toContain('Pick what to view')
  })

  test('still streams a transcript when given an explicit session id without a TTY', async () => {
    const sessionId = '0192abcd-1111-7000-8000-000000000001'
    const proc = Bun.spawn({
      cmd: ['bun', CLI_ENTRY, 'inspect', sessionId],
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // This is a replay-only CLI check, not a probe of the developer's or
      // runner's Docker daemon (which may stall before returning a status).
      env: {
        ...process.env,
        NO_COLOR: '1',
        DOCKER_HOST: 'tcp://127.0.0.1:0',
        DOCKER_CONTEXT: '',
        DOCKER_CONFIG: cwd,
        DOCKER_TLS_VERIFY: '',
      },
    })
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('needs an interactive terminal')
    expect(stdout).toContain('end of transcript')
  })
})
