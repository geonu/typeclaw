import type { DockerExec } from './shared'

const BYTES_PER_MIB = 1024 * 1024
const BYTES_PER_GIB = 1024 * BYTES_PER_MIB

// A container has to hold the Bun runtime, the onnxruntime embedder during an
// index build, a headless Chrome on a heavy page, AND whatever of the 2 GiB
// /dev/shm allowance Chrome actually touches — shm pages are charged to the
// container's cgroup once one exists. 6 GiB clears that comfortably. A cap that
// strangles a legitimate browser or embedding workload is a defect, not
// hardening, so this is deliberately generous rather than minimal.
export const DEFAULT_CONTAINER_MEMORY_BYTES = 6 * BYTES_PER_GIB

// Memory left to the Docker VM itself (dockerd, containerd, the guest kernel,
// page cache) when the default does not fit. Without it a single agent sized to
// the whole machine reproduces the exhaustion this limit exists to prevent.
const HOST_HEADROOM_BYTES = 2 * BYTES_PER_GIB

// Below this a container cannot boot the agent at all, so clamping further down
// would trade a slow host for an agent that never starts.
const MINIMUM_CONTAINER_MEMORY_BYTES = 1 * BYTES_PER_GIB

// Docker refuses `--memory` below 6 MiB outright, so accepting a smaller value
// here would produce a schema-valid config that can only ever fail at container
// creation. Reject it where the operator can still see why.
export const DOCKER_MINIMUM_MEMORY_BYTES = 6 * BYTES_PER_MIB

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([bkmg])$/i

const UNIT_MULTIPLIER: Record<string, number> = {
  b: 1,
  k: 1024,
  m: BYTES_PER_MIB,
  g: BYTES_PER_GIB,
}

// Docker's own size grammar (`512m`, `4g`, `1.5g`). Returns null rather than
// throwing so the config schema can turn it into a field-level message.
export function parseMemorySize(value: string): number | null {
  const match = SIZE_PATTERN.exec(value.trim())
  if (match === null) return null
  const amount = Number(match[1])
  const multiplier = UNIT_MULTIPLIER[match[2]!.toLowerCase()]
  if (!Number.isFinite(amount) || multiplier === undefined) return null
  const bytes = Math.floor(amount * multiplier)
  return bytes >= DOCKER_MINIMUM_MEMORY_BYTES ? bytes : null
}

// Docker accepts a plain byte count, which avoids re-introducing rounding error
// on the way back out of a value we already normalized.
export function formatMemorySize(bytes: number): string {
  return String(Math.floor(bytes))
}

export type MemoryLimitSource = 'configured' | 'default' | 'clamped'

export type ResolvedMemoryLimit = {
  bytes: number
  source: MemoryLimitSource
}

// The limit is a fixed default clamped DOWNWARD to fit the machine, never a
// fraction of it.
//
// A percentage rule breaks precisely where this matters most: on a shared host
// running several agents, "50% of RAM" each oversubscribes by the agent count
// and reproduces the exhaustion with caps that made everyone feel safe. A
// budget that also moves with ambient conditions makes incidents
// unreproducible — the same agent behaves differently depending on what else
// happened to be running when it started.
//
// An explicit operator value always wins outright, including one larger than
// the machine: the operator may be sizing for a host they are about to resize,
// and silently shrinking their stated intent would be its own surprise. The
// oversubscription warning is where that gets surfaced.
export function resolveMemoryLimit(options: {
  configured?: string | undefined
  totalMemoryBytes?: number | undefined
}): ResolvedMemoryLimit {
  const configured = options.configured === undefined ? null : parseMemorySize(options.configured)
  if (configured !== null) return { bytes: configured, source: 'configured' }

  const total = options.totalMemoryBytes
  if (total === undefined || !Number.isFinite(total) || total <= 0) {
    return { bytes: DEFAULT_CONTAINER_MEMORY_BYTES, source: 'default' }
  }

  const affordable = total - HOST_HEADROOM_BYTES
  if (affordable >= DEFAULT_CONTAINER_MEMORY_BYTES) {
    return { bytes: DEFAULT_CONTAINER_MEMORY_BYTES, source: 'default' }
  }
  return { bytes: Math.max(affordable, MINIMUM_CONTAINER_MEMORY_BYTES), source: 'clamped' }
}

// The clamp has to measure the machine the CONTAINER runs on, which on macOS,
// Windows, and any remote-daemon setup is the Docker VM and not the workstation.
// During the incident that motivated this limit the workstation reported tens of
// gigabytes free while the VM died at 14.4 GiB.
//
// So there is deliberately NO os.totalmem() fallback: substituting workstation
// RAM for daemon capacity would reintroduce exactly the mismatch this function
// exists to avoid, and would do it silently. An unreadable daemon total is
// `undefined` — genuinely unknown — and every consumer treats unknown as "do not
// clamp, do not claim oversubscription" rather than inventing a number.
export async function readDockerTotalMemory(exec: DockerExec): Promise<number | undefined> {
  const result = await exec(['info', '--format', '{{.MemTotal}}'])
  if (result.exitCode !== 0) return undefined
  const parsed = Number(result.stdout.trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}
