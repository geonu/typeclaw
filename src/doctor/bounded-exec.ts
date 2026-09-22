import { defaultDockerExec, type DockerExec } from '@/container'

// Every Docker call reachable from `doctor` must carry a deadline.
//
// The bounded availability probe only proves the daemon answered ONCE; it can
// wedge immediately afterward, so gating on it is necessary but not sufficient.
// This is the whole point of the command: an operator runs `doctor` precisely
// when the host is sick, and a diagnostic that blocks forever on the thing it
// is diagnosing is worse than useless.
export const DOCTOR_DOCKER_TIMEOUT_MS = 5_000

export function boundedExec(exec: DockerExec = defaultDockerExec, timeoutMs = DOCTOR_DOCKER_TIMEOUT_MS): DockerExec {
  return (args, options) => exec(args, { ...options, signal: options?.signal ?? AbortSignal.timeout(timeoutMs) })
}
