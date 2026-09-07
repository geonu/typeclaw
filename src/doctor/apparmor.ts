import { readFile } from 'node:fs/promises'

import { loadConfigSync } from '@/config'

import type { CheckResult, DoctorCheck } from './types'

const APPARMOR_ENABLED_PATH = '/sys/module/apparmor/parameters/enabled'
const RESTRICT_UNPRIVILEGED_USERNS_PATH = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

const SHIPPED_PROFILE = 'typeclaw-bwrap'
const DOCKER_DEFAULT_PROFILE = 'docker-default'

const INSTALL_SHIPPED_PROFILE_FIX =
  'Install the shipped scripts/apparmor/typeclaw-bwrap profile as /etc/apparmor.d/typeclaw-bwrap, run `sudo apparmor_parser -r -W /etc/apparmor.d/typeclaw-bwrap`, set `sandbox.apparmorProfile` to `typeclaw-bwrap`, then run `typeclaw restart`.'

export type ApparmorSandboxDeps = {
  readHostFile?: (path: string) => Promise<string | null>
  loadApparmorProfile?: (cwd: string) => string
}

export function apparmorSandbox(deps: ApparmorSandboxDeps = {}): DoctorCheck {
  const readHostFile = deps.readHostFile ?? safeReadHostFile
  const loadApparmorProfile = deps.loadApparmorProfile ?? ((cwd) => loadConfigSync(cwd).sandbox.apparmorProfile)

  return {
    name: 'container.apparmor-bwrap',
    category: 'container',
    description: 'host AppArmor permits the per-tool bwrap sandbox',
    applies: (ctx) => ctx.hasAgentFolder,
    async run(ctx) {
      const [enabled, restricted] = await Promise.all([
        readHostFile(APPARMOR_ENABLED_PATH),
        readHostFile(RESTRICT_UNPRIVILEGED_USERNS_PATH),
      ])
      if (enabled?.trim() !== 'Y') {
        return { status: 'ok', message: 'host AppArmor is not enabled; no container profile applies' }
      }

      let profile: string
      try {
        profile = loadApparmorProfile(ctx.cwd)
      } catch {
        return { status: 'ok', message: 'AppArmor profile check deferred until typeclaw.json is valid' }
      }
      return classifyProfile(profile, restricted?.trim() === '1')
    },
  }
}

// Profile FIRST, host sysctl second. docker-default's `deny mount,` rejects
// bwrap's opening mount(NULL, "/", MS_SLAVE|MS_REC) on any AppArmor-enabled
// host, so gating that verdict on kernel.apparmor_restrict_unprivileged_userns
// would report a dead bash surface as healthy. Only the `unconfined` verdict
// actually depends on the sysctl.
function classifyProfile(profile: string, restrictedUserns: boolean): CheckResult {
  if (profile === SHIPPED_PROFILE) {
    return { status: 'ok', message: `sandbox uses the shipped ${SHIPPED_PROFILE} AppArmor profile` }
  }

  // `error`, not `warning`: an unavailable sandbox makes every model bash call
  // throw SandboxUnavailableError (src/sandbox/availability.ts) — the surface is
  // dead, not degraded.
  if (profile === DOCKER_DEFAULT_PROFILE) {
    return {
      status: 'error',
      message: `AppArmor profile ${DOCKER_DEFAULT_PROFILE} denies the mount that sandboxed bash needs, so every bash call fails`,
      fix: { description: INSTALL_SHIPPED_PROFILE_FIX },
    }
  }

  if (profile === 'unconfined') {
    if (!restrictedUserns) {
      return { status: 'ok', message: 'host AppArmor does not require a custom bwrap profile' }
    }
    return {
      status: 'error',
      message:
        'stock Ubuntu AppArmor blocks the user namespace required by sandboxed bash when sandbox.apparmorProfile is unconfined',
      fix: { description: INSTALL_SHIPPED_PROFILE_FIX },
    }
  }

  // A deliberate operator-authored profile. Doctor cannot read
  // /sys/kernel/security/apparmor/profiles unprivileged, so it can neither
  // confirm nor refute this one — say so rather than assert it works.
  return {
    status: 'info',
    message: `sandbox uses custom AppArmor profile ${profile}; typeclaw cannot verify it permits userns, mount, and signal delivery`,
    details: [
      `Compare it against the shipped ${SHIPPED_PROFILE} profile, and run scripts/verify-apparmor-signals.sh against this host to confirm cancellation and container stop/restart still work.`,
    ],
  }
}

async function safeReadHostFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
