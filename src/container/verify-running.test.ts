import { describe, expect, test } from 'bun:test'

import type { DockerExec, DockerExecResult } from './shared'
import {
  buildCrashReason,
  createVerifyRunning,
  describeUnremovableContainer,
  probeContainer,
  type ContainerLifeStatus,
  type VerifyRunningResult,
} from './verify-running'

type ScriptedResponse = DockerExecResult | ((args: string[]) => DockerExecResult)

function scriptedExec(script: Record<string, ScriptedResponse[]>): {
  exec: DockerExec
  calls: { args: string[]; signal?: AbortSignal }[]
} {
  const calls: { args: string[]; signal?: AbortSignal }[] = []
  const cursors: Record<string, number> = {}
  const exec: DockerExec = async (args, options) => {
    calls.push({ args, signal: options?.signal })
    const key = args[0] ?? ''
    const queue = script[key]
    if (!queue || queue.length === 0) {
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const idx = Math.min(cursors[key] ?? 0, queue.length - 1)
    cursors[key] = (cursors[key] ?? 0) + 1
    const response = queue[idx]!
    return typeof response === 'function' ? response(args) : response
  }
  return { exec, calls }
}

const inspect = (status: ContainerLifeStatus): DockerExecResult => ({
  exitCode: 0,
  stdout: `${status}\n`,
  stderr: '',
})

const inspectMissing: DockerExecResult = { exitCode: 1, stdout: '', stderr: 'Error: No such container: x' }
const inspectDaemonError: DockerExecResult = {
  exitCode: 1,
  stdout: '',
  stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
}

function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('probeContainer', () => {
  test('reports the parsed status when docker inspect exits 0', async () => {
    const { exec } = scriptedExec({ inspect: [inspect('running')] })

    const result = await probeContainer(exec, 'agent')

    expect(result).toEqual({ kind: 'status', status: 'running' })
  })

  test('reports missing only when stderr matches "no such container/object"', async () => {
    const { exec } = scriptedExec({ inspect: [inspectMissing] })

    const result = await probeContainer(exec, 'agent')

    expect(result).toEqual({ kind: 'missing' })
  })

  test('reports daemon-error when docker inspect fails for ANY other reason', async () => {
    const { exec } = scriptedExec({ inspect: [inspectDaemonError] })

    const result = await probeContainer(exec, 'agent')

    expect(result.kind).toBe('daemon-error')
    if (result.kind !== 'daemon-error') throw new Error('expected daemon-error')
    expect(result.detail).toContain('Cannot connect to the Docker daemon')
  })

  test('reports daemon-error when docker inspect returns an unrecognized status', async () => {
    const { exec } = scriptedExec({
      inspect: [{ exitCode: 0, stdout: 'transmogrified\n', stderr: '' }],
    })

    const result = await probeContainer(exec, 'agent')

    expect(result.kind).toBe('daemon-error')
    if (result.kind !== 'daemon-error') throw new Error('expected daemon-error')
    expect(result.detail).toMatch(/unrecognized status/)
  })
})

describe('describeUnremovableContainer', () => {
  test('describes an in-flight removal with the daemon-restart recovery', async () => {
    const { exec } = scriptedExec({ inspect: [inspect('removing')] })

    const result = await describeUnremovableContainer(exec, 'container-id')

    expect(result).toContain('removal is not draining')
    expect(result).toContain('cannot re-enter an in-flight removal')
    expect(result).toContain('Restart Docker or OrbStack')
    expect(result).toContain('next start or restart')
  })

  test('describes a dead container with filesystem recovery', async () => {
    const { exec } = scriptedExec({ inspect: [inspect('dead')] })

    const result = await describeUnremovableContainer(exec, 'container-id')

    expect(result).toContain('marked this container dead')
    expect(result).toContain('could not remove its filesystem')
    expect(result).toContain('Resolve the busy mount or restart Docker, then retry')
  })

  test.each(['exited', 'running'] as const)('returns null for %s', async (status) => {
    const { exec } = scriptedExec({ inspect: [inspect(status)] })

    expect(await describeUnremovableContainer(exec, 'container-id')).toBeNull()
  })

  test('returns null when the status probe is unreadable', async () => {
    const { exec } = scriptedExec({ inspect: [inspectDaemonError] })

    expect(await describeUnremovableContainer(exec, 'container-id')).toBeNull()
  })
})

describe('createVerifyRunning', () => {
  test('returns ok when the first poll already shows running', async () => {
    const { exec } = scriptedExec({ inspect: [inspect('running')] })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 100, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result).toEqual({ ok: true })
  })

  test('does NOT crash-classify a container that polls created then running (startup latency)', async () => {
    // Reproduces the false-positive we were after: docker run -d has returned,
    // the daemon flipped State.SetRunning, but State.Status still briefly
    // reads 'created' on a loaded host. The old design treated this as a crash.
    const { exec } = scriptedExec({
      inspect: [inspect('created'), inspect('created'), inspect('running')],
    })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result).toEqual({ ok: true })
  })

  test('keeps polling through restarting status until it resolves', async () => {
    const { exec } = scriptedExec({
      inspect: [inspect('restarting'), inspect('running')],
    })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result).toEqual({ ok: true })
  })

  test('classifies exited as a crash and captures logs', async () => {
    const { exec, calls } = scriptedExec({
      inspect: [inspect('exited')],
      logs: [{ exitCode: 0, stdout: 'Cannot find package "missing"\n', stderr: '' }],
    })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.mode).toBe('exited')
    if (result.mode !== 'exited') throw new Error('expected exited')
    expect(result.status).toBe('exited')
    expect(result.logs).toEqual({ ok: true, text: 'Cannot find package "missing"' })
    expect(calls.some((c) => c.args[0] === 'logs')).toBe(true)
  })

  test('classifies a missing container as removed (anomaly: external process removed it during verify)', async () => {
    const { exec } = scriptedExec({
      inspect: [inspectMissing],
      logs: [{ exitCode: 1, stdout: '', stderr: 'Error: No such container: logs' }],
    })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.mode).toBe('removed')
  })

  test('surfaces a daemon error WITHOUT misclassifying it as a container crash', async () => {
    // The pre-refactor bug: any non-zero exit from `inspect` was treated as
    // "container missing" -> crash. A Docker hiccup (socket timeout, 500,
    // daemon restart) therefore produced a confident "your container crashed"
    // message. Now those produce a distinct daemon-error mode.
    const { exec } = scriptedExec({ inspect: [inspectDaemonError] })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.mode).toBe('daemon-error')
  })

  test('returns ok when timeout elapses with the container always running (full stability window)', async () => {
    let polls = 0
    const exec: DockerExec = async (args) => {
      if (args[0] === 'inspect') {
        polls += 1
        return inspect('running')
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 100, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result).toEqual({ ok: true })
    expect(polls).toBeGreaterThan(1)
  })

  test('returns ok immediately and does NOT call inspect when timeoutMs is 0', async () => {
    const { exec, calls } = scriptedExec({ inspect: [inspect('running')] })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 0, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result).toEqual({ ok: true })
    expect(calls.length).toBe(0)
  })

  test('docker logs is invoked with a signal so a stuck daemon does not hang verification', async () => {
    let observedSignal: AbortSignal | undefined
    const exec: DockerExec = async (args, options) => {
      if (args[0] === 'inspect') return inspect('exited')
      if (args[0] === 'logs') {
        observedSignal = options?.signal
        return { exitCode: 0, stdout: 'crash output\n', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const clock = fakeClock()
    const verify = createVerifyRunning({
      exec,
      timeoutMs: 1000,
      intervalMs: 50,
      logsTimeoutMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    })

    await verify('agent')

    expect(observedSignal).toBeInstanceOf(AbortSignal)
  })

  test('preserves partial log output when docker logs eventually fails', async () => {
    const { exec } = scriptedExec({
      inspect: [inspect('exited')],
      logs: [{ exitCode: 1, stdout: 'partial output before crash', stderr: 'lost connection' }],
    })
    const clock = fakeClock()
    const verify = createVerifyRunning({ exec, timeoutMs: 1000, intervalMs: 50, now: clock.now, sleep: clock.sleep })

    const result = await verify('agent')

    expect(result.ok).toBe(false)
    if (result.ok || result.mode === 'daemon-error') throw new Error('expected crash mode')
    expect(result.logs.ok).toBe(false)
    if (result.logs.ok) throw new Error('expected logs.ok=false')
    expect(result.logs.error).toContain('partial logs preserved')
  })
})

describe('buildCrashReason', () => {
  test('formats the removed mode with captured logs', () => {
    const failure: VerifyRunningResult = {
      ok: false,
      mode: 'removed',
      logs: { ok: true, text: 'error: bad config' },
    }
    if (failure.ok) throw new Error('unreachable')

    const reason = buildCrashReason('agent', failure)

    expect(reason).toContain('disappeared during start verification')
    expect(reason).toContain('error: bad config')
  })

  test('formats the exited mode with the observed terminal status', () => {
    const failure: VerifyRunningResult = {
      ok: false,
      mode: 'exited',
      status: 'dead',
      logs: { ok: true, text: 'segfault' },
    }
    if (failure.ok) throw new Error('unreachable')

    const reason = buildCrashReason('agent', failure)

    expect(reason).toMatch(/stopped running.*dead/)
    expect(reason).toContain('segfault')
  })

  test('says "produced no logs" when capture succeeded but the container was silent', () => {
    const failure: VerifyRunningResult = {
      ok: false,
      mode: 'removed',
      logs: { ok: true, text: '' },
    }
    if (failure.ok) throw new Error('unreachable')

    const reason = buildCrashReason('agent', failure)

    expect(reason).toMatch(/produced no logs/)
  })

  test('surfaces the log read error when capture failed (not "no logs were captured")', () => {
    const failure: VerifyRunningResult = {
      ok: false,
      mode: 'removed',
      logs: { ok: false, error: 'docker logs timed out after 500ms' },
    }
    if (failure.ok) throw new Error('unreachable')

    const reason = buildCrashReason('agent', failure)

    expect(reason).toMatch(/Could not read container logs/)
    expect(reason).toContain('docker logs timed out')
  })

  test('formats daemon-error as a distinct "could not verify" message', () => {
    const failure: VerifyRunningResult = {
      ok: false,
      mode: 'daemon-error',
      detail: 'Cannot connect to the Docker daemon',
    }
    if (failure.ok) throw new Error('unreachable')

    const reason = buildCrashReason('agent', failure)

    expect(reason).toMatch(/Could not verify/)
    expect(reason).toContain('Cannot connect to the Docker daemon')
  })
})
