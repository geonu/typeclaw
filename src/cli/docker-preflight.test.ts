import { describe, expect, test } from 'bun:test'

import type { DockerAppProbes, DockerExec } from '@/container'

import { preflightDocker } from './docker-preflight'

function execReturning(exitCode: number, stderr = ''): DockerExec {
  return async () => ({ exitCode, stdout: exitCode === 0 ? '27.0.0' : '', stderr })
}

// Pin every detection input so the result does not depend on which Docker
// runtimes are installed on the machine running the suite.
const NOTHING_INSTALLED: DockerAppProbes = {
  platform: 'darwin',
  exists: () => false,
  which: () => null,
  env: {},
}

const ORBSTACK_INSTALLED: DockerAppProbes = {
  platform: 'darwin',
  exists: (path) => path === '/Applications/OrbStack.app',
  which: () => null,
  env: {},
}

describe('preflightDocker', () => {
  test('ok when docker info succeeds', async () => {
    const result = await preflightDocker(execReturning(0))
    expect(result.ok).toBe(true)
  })

  test('daemon-down yields a non-ok result with summary and guidance', async () => {
    const stderr =
      'failed to connect to the docker API at unix:///home/user/.docker/run/docker.sock; check if the daemon is running'
    const result = await preflightDocker(execReturning(1, stderr))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.summary.length).toBeGreaterThan(0)
    expect(result.guidance.length).toBeGreaterThan(0)
  })

  test('binary-missing yields install guidance when nothing is installed', async () => {
    const result = await preflightDocker(execReturning(-1, 'docker: command not found in $PATH'), NOTHING_INSTALLED)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.summary).toBe('Docker is not installed.')
    expect(result.guidance.join('\n')).toContain('https://orbstack.dev')
  })

  test('binary-missing does not claim Docker is missing when a runtime is installed', async () => {
    const result = await preflightDocker(execReturning(-1, 'docker: command not found in $PATH'), ORBSTACK_INSTALLED)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.summary).not.toContain('Docker is not installed')
    expect(result.summary).toContain('OrbStack')
    expect(result.guidance.join('\n')).toContain('PATH')
  })
})
