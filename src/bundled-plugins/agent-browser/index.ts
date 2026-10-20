import { join } from 'node:path'

import { getConfig } from '@/config'
import { definePlugin } from '@/plugin'
import { publishForwardRequest, subscribeForwardResult } from '@/portbroker'

// Documented in skills/agent-browser/SKILL.md so the agent can discover which
// host port the reserved dashboard forward actually bound. Moving or renaming
// this path requires updating the skill in lockstep. The env override is an
// internal escape hatch for the parallel test harness (many worker processes on
// one host must not clobber a single shared /tmp path); production uses the
// documented default and the skill contract is unchanged.
const DEFAULT_PROXY_PORT_HINT_PATH = '/tmp/typeclaw-agent-browser-proxy-port'
const PROXY_PORT_HINT_PATH_ENV = 'TYPECLAW_AGENT_BROWSER_PROXY_PORT_HINT_PATH'

function proxyPortHintPath(): string {
  return process.env[PROXY_PORT_HINT_PATH_ENV] || DEFAULT_PROXY_PORT_HINT_PATH
}

const DASHBOARD_TARGET_PORT = 4848
const DASHBOARD_HOST_CANDIDATES = [4848, 4849, 4850, 4851, 4852, 4853, 4854, 4855, 4856, 4857] as const

let unsubscribeForwardResult: (() => void) | null = null

export default definePlugin({
  plugin: async (ctx) => {
    if (!getConfig().browser.engines.includes('agent-browser')) return {}
    requestDashboardForward(ctx.logger)

    return {
      skillsDirs: [join(import.meta.dir, 'skills')],
    }
  },
})

export function __resetForwardRequestForTesting(): void {
  unsubscribeForwardResult?.()
  unsubscribeForwardResult = null
}

function requestDashboardForward(logger: { info: (msg: string) => void; warn: (msg: string) => void }): void {
  if (!defaultBrokerEnabled()) {
    void recordProxyPort('TypeClaw dashboard forwarding unavailable: hostd broker is disabled.', logger)
    return
  }

  if (unsubscribeForwardResult === null) {
    unsubscribeForwardResult = subscribeForwardResult((event) => {
      if (event.port !== DASHBOARD_TARGET_PORT) return
      if (event.ok) {
        void recordProxyPort(String(event.hostPort), logger)
        logger.info(`agent-browser dashboard forward reserved on host:${event.hostPort}`)
        return
      }
      void recordProxyPort(`TypeClaw dashboard forwarding unavailable: ${event.reason}`, logger)
      logger.warn(`agent-browser dashboard forward failed: ${event.reason}`)
    })
  }

  publishForwardRequest({
    targetPort: DASHBOARD_TARGET_PORT,
    hostCandidates: [...DASHBOARD_HOST_CANDIDATES],
    reason: 'agent-browser-dashboard',
  })
}

function defaultBrokerEnabled(): boolean {
  const token = process.env['TYPECLAW_HOSTD_BROKER_TOKEN']
  return token !== undefined && token.length > 0
}

async function recordProxyPort(contents: string, logger: { warn: (msg: string) => void }): Promise<void> {
  const path = proxyPortHintPath()
  try {
    await Bun.write(path, contents)
  } catch (error) {
    // Hint is informational (lets a future `typeclaw status` or a human shell
    // session report which port to open). Failure is non-fatal.
    logger.warn(`failed to write ${path}: ${String(error)}`)
  }
}
