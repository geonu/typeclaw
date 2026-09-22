import {
  checkDockerAvailable,
  detectInstalledDockerApps,
  pickRuntimeToNudge,
  renderDockerUnavailableGuidance,
  type DockerAppProbes,
  type DockerExec,
} from '@/container'

import { c, errorLine } from './ui'

export type DockerPreflightResult = { ok: true } | { ok: false; summary: string; guidance: string[] }

// Single host-side gate every Docker-dependent CLI command calls before it
// spawns docker. Without it the raw daemon-down stderr (an unactionable socket
// path) leaks straight to the user. This probes once via checkDockerAvailable,
// then hands the friendly, runtime-specific guidance back to the caller so each
// command renders it in its own style (spinner vs console) — no process.exit
// here, that belongs to the command.
export async function preflightDocker(exec?: DockerExec, probes?: DockerAppProbes): Promise<DockerPreflightResult> {
  const availability = exec ? await checkDockerAvailable(exec) : await checkDockerAvailable()
  if (availability.ok) return { ok: true }

  const detail = availability.reason === 'daemon-down' ? availability.detail : undefined
  // Probes are injectable so tests do not depend on which Docker runtimes
  // happen to be installed on the machine running them.
  const installed = detectInstalledDockerApps(probes)
  const env = probes?.env ?? process.env
  const nudge = pickRuntimeToNudge(env, detail, installed)
  const { summary, lines } = renderDockerUnavailableGuidance(availability, {
    platform: probes?.platform ?? process.platform,
    nudge,
    installed,
  })
  return { ok: false, summary, guidance: lines }
}

// Prints the friendly guidance to stderr in the standard CLI error style
// (red ✖ summary, then dimmed guidance lines). Shared by every command's
// non-spinner failure path so the look is identical everywhere.
export function printDockerGuidance(failure: Extract<DockerPreflightResult, { ok: false }>): void {
  console.error(errorLine(failure.summary))
  for (const line of failure.guidance) {
    console.error(line === '' ? '' : c.dim(line))
  }
}
