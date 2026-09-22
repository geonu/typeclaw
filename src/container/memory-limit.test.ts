import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_CONTAINER_MEMORY_BYTES,
  DOCKER_MINIMUM_MEMORY_BYTES,
  formatMemorySize,
  parseMemorySize,
  readDockerTotalMemory,
  resolveMemoryLimit,
} from './memory-limit'
import type { DockerExec } from './shared'

const GIB = 1024 * 1024 * 1024

describe('parseMemorySize', () => {
  test('accepts the docker size grammar', () => {
    expect(parseMemorySize('4g')).toBe(4 * GIB)
    expect(parseMemorySize('512m')).toBe(512 * 1024 * 1024)
    expect(parseMemorySize('1.5g')).toBe(1.5 * GIB)
    expect(parseMemorySize('8192k')).toBe(8192 * 1024)
    expect(parseMemorySize(' 4G ')).toBe(4 * GIB)
  })

  test('rejects anything docker would not take', () => {
    expect(parseMemorySize('4')).toBeNull()
    expect(parseMemorySize('4gb')).toBeNull()
    expect(parseMemorySize('lots')).toBeNull()
    expect(parseMemorySize('0g')).toBeNull()
    expect(parseMemorySize('-4g')).toBeNull()
    expect(parseMemorySize('')).toBeNull()
  })

  test('rejects values below docker own 6 MiB floor', () => {
    // given a value docker itself refuses, which would otherwise be
    // schema-valid and fail only at container creation
    expect(parseMemorySize('1m')).toBeNull()
  })

  test('accepts exactly the 6 MiB floor and rejects just below it', () => {
    expect(parseMemorySize(`${DOCKER_MINIMUM_MEMORY_BYTES}b`)).toBe(DOCKER_MINIMUM_MEMORY_BYTES)
    expect(parseMemorySize(`${DOCKER_MINIMUM_MEMORY_BYTES - 1}b`)).toBeNull()
  })
})

describe('resolveMemoryLimit', () => {
  test('an explicit operator value wins outright', () => {
    const result = resolveMemoryLimit({ configured: '12g', totalMemoryBytes: 8 * GIB })

    expect(result).toEqual({ bytes: 12 * GIB, source: 'configured' })
  })

  test('applies the fixed default on a machine that can afford it', () => {
    const result = resolveMemoryLimit({ configured: undefined, totalMemoryBytes: 64 * GIB })

    expect(result).toEqual({ bytes: DEFAULT_CONTAINER_MEMORY_BYTES, source: 'default' })
  })

  test('never scales up with host memory', () => {
    // given a very large machine
    const huge = resolveMemoryLimit({ configured: undefined, totalMemoryBytes: 512 * GIB })

    // then the default is still the default — a fraction-of-RAM rule would
    // oversubscribe by the agent count on a shared host
    expect(huge.bytes).toBe(DEFAULT_CONTAINER_MEMORY_BYTES)
  })

  test('clamps down when the default would not leave the host headroom', () => {
    // given a 4GiB Docker VM, which cannot give 6GiB away and still run
    const result = resolveMemoryLimit({ configured: undefined, totalMemoryBytes: 4 * GIB })

    expect(result.source).toBe('clamped')
    expect(result.bytes).toBeLessThan(DEFAULT_CONTAINER_MEMORY_BYTES)
    expect(result.bytes).toBeLessThanOrEqual(4 * GIB)
  })

  test('never clamps below a bootable floor', () => {
    const result = resolveMemoryLimit({ configured: undefined, totalMemoryBytes: 1 * GIB })

    expect(result.bytes).toBeGreaterThanOrEqual(1 * GIB)
  })

  test('falls back to the default when total memory is unknown', () => {
    expect(resolveMemoryLimit({ configured: undefined, totalMemoryBytes: undefined }).source).toBe('default')
    expect(resolveMemoryLimit({ configured: undefined, totalMemoryBytes: 0 }).source).toBe('default')
  })

  test('ignores an unparseable configured value rather than failing the start', () => {
    const result = resolveMemoryLimit({ configured: 'not-a-size', totalMemoryBytes: 64 * GIB })

    expect(result.source).toBe('default')
  })
})

describe('formatMemorySize', () => {
  test('renders a plain byte count docker accepts', () => {
    expect(formatMemorySize(6 * GIB)).toBe('6442450944')
  })
})

describe('readDockerTotalMemory', () => {
  test('reads the daemon total, not the workstation total', async () => {
    // given a Docker VM smaller than the machine hosting it, the macOS case
    // that let a workstation with free memory still lose its VM
    const exec: DockerExec = async () => ({ exitCode: 0, stdout: `${8 * GIB}\n`, stderr: '' })

    expect(await readDockerTotalMemory(exec)).toBe(8 * GIB)
  })

  test('reports unknown rather than substituting workstation RAM', async () => {
    // given a daemon that cannot be asked; falling back to os.totalmem() would
    // reintroduce the very host-vs-VM mismatch this function exists to avoid
    const exec: DockerExec = async () => ({ exitCode: 1, stdout: '', stderr: 'daemon down' })

    expect(await readDockerTotalMemory(exec)).toBeUndefined()
  })

  test('reports unknown when the daemon returns a nonsense total', async () => {
    const exec: DockerExec = async () => ({ exitCode: 0, stdout: 'not-a-number\n', stderr: '' })

    expect(await readDockerTotalMemory(exec)).toBeUndefined()
  })
})
