import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DockerExecResult } from '@/container'
import { rmTempDir } from '@/test-helpers/rm-temp-dir'

import { formatStatus, type HostdStatus, parseStatusResult, runStatus, type StatusReport } from './status'

function baseReport(overrides: Partial<StatusReport> = {}): StatusReport {
  return {
    cwd: '/agents/coder',
    container: { kind: 'missing', containerName: 'coder', imageTag: 'typeclaw-coder' },
    hostd: { kind: 'unreachable' },
    ...overrides,
  }
}

describe('formatStatus', () => {
  test('renders three sections with labels for missing container + unreachable daemon', () => {
    const out = formatStatus(baseReport())

    expect(out).toContain('Container  coder')
    expect(out).toContain('  cwd     /agents/coder')
    expect(out).toContain('  image   typeclaw-coder')
    expect(out).toContain('  state   missing')
    expect(out).toContain('Host daemon')
    expect(out).toContain('  state   unreachable')
    expect(out).toContain('Port forwarding')
    expect(out).toContain('requires the host daemon')
  })

  test('shows running state with shortened container id and host port mapping', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:abcdef0123456789',
          configuredImage: 'typeclaw-coder',
          hostPort: 51234,
          hostBindAddr: '0.0.0.0',
        },
      }),
    )

    expect(out).toContain('  state   running')
    expect(out).toContain('  id      abcdef012345')
    expect(out).toContain('  port    0.0.0.0:51234 -> container:51234')
  })

  test('shows stopped state with id but no port row', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'stopped',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:1234567890ab',
          configuredImage: 'typeclaw-coder',
        },
      }),
    )

    expect(out).toContain('  state   stopped')
    expect(out).toContain('  id      1234567890ab')
    expect(out).not.toContain('  port    ')
  })

  test('shows running with unknown port when docker port returned nothing', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:abc',
          configuredImage: 'typeclaw-coder',
          hostPort: null,
          hostBindAddr: null,
        },
      }),
    )

    expect(out).toContain('  port    unknown')
  })

  test('renders forwarded ports sorted ascending when hostd is registered', () => {
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'registered', cwd: '/agents/coder', forwardedPorts: [3000, 5173, 8080] },
      }),
    )

    expect(out).toContain('Host daemon')
    expect(out).toContain('  state   registered')
    const portsBlock = out.slice(out.indexOf('Port forwarding'))
    const indices = [3000, 5173, 8080].map((p) => portsBlock.indexOf(`127.0.0.1:${p}`))
    expect(indices.every((i) => i >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })

  test('renders empty forwarding hint when registered but no ports open', () => {
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'registered', cwd: '/agents/coder', forwardedPorts: [] },
      }),
    )

    expect(out).toContain('Port forwarding')
    expect(out).toContain('no ports currently forwarded')
  })

  test('renders not-registered state with reason', () => {
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'not-registered', reason: 'not registered: coder' },
      }),
    )

    expect(out).toContain('  state   not registered')
    expect(out).toContain('  reason  not registered: coder')
  })

  test('useColor=true wraps section headers with ANSI escapes', () => {
    const out = formatStatus(baseReport(), { useColor: true })
    const ESC = '\u001b'
    const BOLD = `${ESC}[1m`

    expect(out).toContain(`${BOLD}Container`)
    expect(out).toContain(`${BOLD}Host daemon`)
    expect(out).toContain(`${BOLD}Port forwarding`)
  })

  test('renders empty forwarding hint when daemon omits forwardedPorts (drift)', () => {
    const parsed = parseStatusResult({ containerName: 'coder', cwd: '/agents/coder' })
    expect(parsed).toEqual({ containerName: 'coder', cwd: '/agents/coder', forwardedPorts: [] })
    const out = formatStatus(
      baseReport({
        hostd: { kind: 'registered', cwd: parsed!.cwd, forwardedPorts: parsed!.forwardedPorts },
      }),
    )
    expect(out).toContain('no ports currently forwarded')
  })

  test('parser drops non-numeric forwardedPorts entries', () => {
    const parsed = parseStatusResult({
      containerName: 'coder',
      cwd: '/agents/coder',
      forwardedPorts: [3000, 'nope', null, 5173, Number.NaN, 8080],
    })
    expect(parsed?.forwardedPorts).toEqual([3000, 5173, 8080])
  })

  test('parser rejects payloads without a string cwd', () => {
    expect(parseStatusResult(null)).toBeNull()
    expect(parseStatusResult('hi')).toBeNull()
    expect(parseStatusResult({ containerName: 'coder' })).toBeNull()
    expect(parseStatusResult({ cwd: 42 })).toBeNull()
  })

  test('useColor=false produces output free of ANSI escape codes', () => {
    const out = formatStatus(
      baseReport({
        container: {
          kind: 'running',
          containerName: 'coder',
          imageTag: 'typeclaw-coder',
          containerId: 'sha256:abcdef012345',
          configuredImage: 'typeclaw-coder',
          hostPort: 51234,
          hostBindAddr: '127.0.0.1',
        },
        hostd: { kind: 'registered', cwd: '/x', forwardedPorts: [5173] },
      }),
    )

    expect(out).not.toContain('\u001b[')
  })
})

// The CLI-boot path that turns a broken typeclaw.json into a stderr warning
// instead of a crash is covered end-to-end (real subprocess) by the broken-config
// tests in model.test.ts / role.test.ts, whose commands share the same boot +
// loadConfigSyncOrDefaults path. Here we cover the status-specific contract: the
// render flow still completes and prints all three sections even when Docker is
// available but the daemon/container are absent. Injecting preflight + exec keeps
// this off the real `docker info`, which cold-starts Docker Desktop for ~70s on
// the first probe of a Windows CI run.
describe('typeclaw status render flow', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'typeclaw-status-render-'))
  })

  afterEach(async () => {
    await rmTempDir(cwd)
  })

  const missingContainerExec = async (): Promise<DockerExecResult> => ({
    exitCode: 1,
    stdout: '',
    stderr: 'Error: No such container: tc-agent',
  })

  async function captureStatus(deps: { fetchHostd?: () => Promise<HostdStatus> } = {}): Promise<string> {
    let out = ''
    await runStatus({
      cwd,
      preflight: async () => ({ ok: true }),
      exec: missingContainerExec,
      fetchHostd: deps.fetchHostd ?? (async () => ({ kind: 'unreachable' })),
      write: (text) => {
        out += text
      },
    })
    return out
  }

  test('renders all three sections for a missing container + unreachable daemon', async () => {
    const out = await captureStatus()
    expect(out).toContain('Container')
    expect(out).toContain('Host daemon')
    expect(out).toContain('Port forwarding')
    expect(out).toContain('missing')
  })

  test('renders forwarded ports when the daemon reports a registered container', async () => {
    const out = await captureStatus({
      fetchHostd: async () => ({ kind: 'registered', cwd, forwardedPorts: [8973] }),
    })
    expect(out).toContain('Host daemon')
    expect(out).toContain('8973')
  })

  test('does not exit the process when Docker is available', async () => {
    await expect(captureStatus()).resolves.toBeString()
  })

  test('the default docker-unavailable path sets exitCode instead of exiting mid-write', async () => {
    // given the real failure handler, which previously called process.exit(1)
    // immediately after writing the report — truncating a piped stdout
    const previousExitCode = process.exitCode
    let out = ''
    try {
      await runStatus({
        cwd,
        preflight: async () => ({
          ok: false,
          summary: 'OrbStack is running but not responding. It needs a restart.',
          guidance: ['Restart OrbStack, then retry.'],
        }),
        fetchHostd: async () => ({ kind: 'unreachable' }),
        write: (text) => {
          out += text
        },
      })

      // then it returns normally with a non-zero exit code, and the report is
      // fully written rather than cut short by a forced exit
      expect(process.exitCode).toBe(1)
      expect(out).toContain('Container')
      expect(out).toContain('Port forwarding')
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test('still reports host daemon and forwarded ports when Docker is unavailable', async () => {
    // given a wedged Docker daemon but a healthy host daemon — the exact state
    // during a livelocked-VM incident, and the moment the report matters most
    let out = ''
    const guidance: string[] = []
    await runStatus({
      cwd,
      preflight: async () => ({
        ok: false,
        summary: 'OrbStack is running but not responding. It needs a restart.',
        guidance: ['Restart OrbStack, then retry: `orb stop`, then reopen OrbStack.'],
      }),
      fetchHostd: async () => ({ kind: 'registered', cwd, forwardedPorts: [8973] }),
      write: (text) => {
        out += text
      },
      onDockerUnavailable: (failure) => {
        guidance.push(failure.summary)
      },
    })

    // then the Docker-independent facts are still on screen, and the docker
    // failure is named rather than silently swallowed
    expect(out).toContain('Host daemon')
    expect(out).toContain('8973')
    expect(out).toContain('unknown')
    expect(out).toContain('not responding')
    expect(guidance).toEqual(['OrbStack is running but not responding. It needs a restart.'])
  })
})
