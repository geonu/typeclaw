import { describe, expect, test } from 'bun:test'

import {
  formatCgroupMemory,
  formatCpuMax,
  parseCgroupMemory,
  parseCpuMax,
  resolveCgroupV1File,
  resolveCgroupV1Path,
} from './resource-report'

describe('parseCgroupMemory', () => {
  test('parses a numeric byte limit (v2 memory.max) as finite', () => {
    expect(parseCgroupMemory('536870912\n')).toEqual({ kind: 'finite', value: 536870912 })
  })

  test('treats "max" (v2 unlimited) as unlimited', () => {
    expect(parseCgroupMemory('max\n')).toEqual({ kind: 'unlimited' })
  })

  test('treats the 4 KiB-page v1 unlimited sentinel as unlimited', () => {
    expect(parseCgroupMemory('9223372036854771712\n')).toEqual({ kind: 'unlimited' })
  })

  test('treats the 64 KiB-page v1 unlimited sentinel as unlimited (page-size independent)', () => {
    // given: LONG_MAX rounded to a 64 KiB boundary — smaller than the 4 KiB value
    expect(parseCgroupMemory('9223372036854710272\n')).toEqual({ kind: 'unlimited' })
  })

  test('treats missing/unreadable (null) as unknown', () => {
    expect(parseCgroupMemory(null)).toEqual({ kind: 'unknown' })
  })

  test('treats malformed content as unknown, NOT unlimited', () => {
    expect(parseCgroupMemory('')).toEqual({ kind: 'unknown' })
    expect(parseCgroupMemory('garbage')).toEqual({ kind: 'unknown' })
  })
})

describe('formatCgroupMemory', () => {
  test('renders a finite limit in MB', () => {
    expect(formatCgroupMemory({ kind: 'finite', value: 512 * 1024 * 1024 })).toBe('mem_limit_mb=512')
  })

  test('renders genuine unlimited', () => {
    expect(formatCgroupMemory({ kind: 'unlimited' })).toBe('mem_limit_mb=unlimited')
  })

  test('renders unknown as ? (a read failure is not a claim of unlimited)', () => {
    expect(formatCgroupMemory({ kind: 'unknown' })).toBe('mem_limit_mb=?')
  })
})

describe('parseCpuMax', () => {
  test('parses "quota period" into a finite fractional cpu count', () => {
    // given: 150000us quota per 100000us period → 1.5 CPUs
    expect(parseCpuMax('150000 100000\n')).toEqual({ kind: 'finite', value: 1.5 })
  })

  test('treats "max" quota as unlimited (v2)', () => {
    expect(parseCpuMax('max 100000\n')).toEqual({ kind: 'unlimited' })
  })

  test('treats the v1 "-1" quota sentinel as unlimited, not a negative cpu count', () => {
    // given: cpu.cfs_quota_us=-1 means no limit; passed as "-1 100000"
    expect(parseCpuMax('-1 100000\n')).toEqual({ kind: 'unlimited' })
  })

  test('treats a zero quota as unknown, NOT unlimited', () => {
    // given: 0 is not a genuine no-limit sentinel (only max / -1 are)
    expect(parseCpuMax('0 100000')).toEqual({ kind: 'unknown' })
  })

  test('validates shape BEFORE the max sentinel: a malformed max record is unknown', () => {
    // given: `max` must not short-circuit to unlimited past a broken period/arity
    expect(parseCpuMax('max garbage')).toEqual({ kind: 'unknown' })
    expect(parseCpuMax('max 100000 extra')).toEqual({ kind: 'unknown' })
    expect(parseCpuMax('max 0')).toEqual({ kind: 'unknown' })
  })

  test('rejects more than two fields', () => {
    expect(parseCpuMax('150000 100000 extra')).toEqual({ kind: 'unknown' })
  })

  test('treats missing (null) as unknown', () => {
    expect(parseCpuMax(null)).toEqual({ kind: 'unknown' })
  })

  test('treats malformed content as unknown, NOT unlimited', () => {
    expect(parseCpuMax('')).toEqual({ kind: 'unknown' })
    expect(parseCpuMax('nope')).toEqual({ kind: 'unknown' })
  })
})

describe('formatCpuMax', () => {
  test('renders a finite cpu quota', () => {
    expect(formatCpuMax({ kind: 'finite', value: 1.5 })).toBe('cpu_quota=1.5')
  })

  test('renders genuine unlimited', () => {
    expect(formatCpuMax({ kind: 'unlimited' })).toBe('cpu_quota=unlimited')
  })

  test('renders unknown as ?', () => {
    expect(formatCpuMax({ kind: 'unknown' })).toBe('cpu_quota=?')
  })
})

describe('resolveCgroupV1Path', () => {
  test('resolves the container mount+sub-path for a cgroupfs docker layout', () => {
    // given: /proc/self/cgroup line for the memory controller under docker
    const proc = '12:memory:/docker/abc123\n11:cpu,cpuacct:/docker/abc123\n'
    expect(resolveCgroupV1Path(proc, 'memory')).toEqual({ mount: 'memory', subPath: '/docker/abc123' })
  })

  test('resolves a systemd-slice docker layout', () => {
    const proc = '9:memory:/system.slice/docker-abc123.scope\n'
    expect(resolveCgroupV1Path(proc, 'memory')).toEqual({
      mount: 'memory',
      subPath: '/system.slice/docker-abc123.scope',
    })
  })

  test('returns the combined mount name (cpu,cpuacct) for a controller in a shared mount', () => {
    // given: cpu is mounted under the combined dir `cpu,cpuacct`, not a bare `cpu`
    const proc = '11:cpu,cpuacct:/docker/abc123\n'
    expect(resolveCgroupV1Path(proc, 'cpu')).toEqual({ mount: 'cpu,cpuacct', subPath: '/docker/abc123' })
    expect(resolveCgroupV1Path(proc, 'cpuacct')).toEqual({ mount: 'cpu,cpuacct', subPath: '/docker/abc123' })
  })

  test('returns root sub-path when the controller sits at the hierarchy root', () => {
    const proc = '12:memory:/\n'
    expect(resolveCgroupV1Path(proc, 'memory')).toEqual({ mount: 'memory', subPath: '/' })
  })

  test('returns null when the controller is absent', () => {
    expect(resolveCgroupV1Path('12:pids:/docker/abc\n', 'memory')).toBeNull()
    expect(resolveCgroupV1Path(null, 'memory')).toBeNull()
  })
})

describe('resolveCgroupV1File', () => {
  test('maps a subtree-mounted hierarchy to the mountpoint (membership == mount root)', () => {
    // given: hierarchy root /docker/abc123 is bind-mounted AT /sys/fs/cgroup/memory,
    // so the file sits directly at the mountpoint, not under the membership path
    const cgroup = '12:memory:/docker/abc123\n'
    const mountinfo = '31 30 0:27 /docker/abc123 /sys/fs/cgroup/memory rw,nosuid - cgroup cgroup rw,memory\n'
    expect(resolveCgroupV1File(cgroup, mountinfo, 'memory', 'memory.limit_in_bytes')).toBe(
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    )
  })

  test('joins the sub-path when the whole hierarchy is mounted (root /)', () => {
    // given: root=/ mount, membership /docker/abc123 → mountpoint + sub-path
    const cgroup = '12:memory:/docker/abc123\n'
    const mountinfo = '31 30 0:27 / /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n'
    expect(resolveCgroupV1File(cgroup, mountinfo, 'memory', 'memory.limit_in_bytes')).toBe(
      '/sys/fs/cgroup/memory/docker/abc123/memory.limit_in_bytes',
    )
  })

  test('resolves a controller in a combined cpu,cpuacct mount via its super-options', () => {
    const cgroup = '11:cpu,cpuacct:/docker/abc123\n'
    const mountinfo = '33 30 0:29 /docker/abc123 /sys/fs/cgroup/cpu,cpuacct rw - cgroup cgroup rw,cpu,cpuacct\n'
    expect(resolveCgroupV1File(cgroup, mountinfo, 'cpu', 'cpu.cfs_quota_us')).toBe(
      '/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us',
    )
  })

  test('returns null when no cgroup mount carries the controller', () => {
    const cgroup = '12:memory:/docker/abc123\n'
    const mountinfo = '31 30 0:27 / /sys/fs/cgroup/pids rw - cgroup cgroup rw,pids\n'
    expect(resolveCgroupV1File(cgroup, mountinfo, 'memory', 'memory.limit_in_bytes')).toBeNull()
  })

  test('returns null when membership or mountinfo is missing', () => {
    expect(resolveCgroupV1File(null, 'x', 'memory', 'f')).toBeNull()
    expect(resolveCgroupV1File('12:memory:/x\n', null, 'memory', 'f')).toBeNull()
  })
})
