import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'

import { config, validateConfig } from '@/config'
import { type Controller, resolveController } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { guardIncompleteInit } from './incomplete-init'
import { c, errorLine, renderStartSuccess, reportConfigWarnings, spinner } from './ui'

export type RestartCommandEvent =
  | { kind: 'stop-spinner-start'; message: string }
  | { kind: 'stop-spinner-stop'; message: string }
  | { kind: 'stop-spinner-error'; message: string }
  | { kind: 'start-spinner-start'; message: string }
  | { kind: 'start-spinner-stop'; message: string }
  | { kind: 'start-spinner-error'; message: string }
  | { kind: 'warnings'; warnings: string[] }
  | { kind: 'success'; output: string }

export type RestartCommandDeps = {
  restart: Controller['restart']
  onEvent: (event: RestartCommandEvent) => void
}

export async function runRestartCommand(
  options: { cwd: string; preferredHostPort: number; forceBuild: boolean; cliEntry?: string },
  deps: RestartCommandDeps,
): Promise<{ ok: boolean }> {
  deps.onEvent({ kind: 'stop-spinner-start', message: 'Stopping container...' })
  let stopped = false
  const warnings: string[] = []
  const result = await deps.restart({
    ...options,
    onWarning: (warning) => warnings.push(warning),
    onStopped: (stopResult) => {
      stopped = true
      deps.onEvent({
        kind: 'stop-spinner-stop',
        message: stopResult.running ? `Stopped ${c.cyan(stopResult.containerName)}.` : 'Already stopped.',
      })
      deps.onEvent({ kind: 'start-spinner-start', message: 'Starting container...' })
    },
  })
  if (!result.ok) {
    deps.onEvent({ kind: stopped ? 'start-spinner-error' : 'stop-spinner-error', message: result.reason })
    deps.onEvent({ kind: 'warnings', warnings })
    return { ok: false }
  }

  deps.onEvent({ kind: 'start-spinner-stop', message: 'Started.' })
  deps.onEvent({ kind: 'warnings', warnings })
  deps.onEvent({ kind: 'warnings', warnings: result.start.dockerfileWarnings })
  deps.onEvent({ kind: 'success', output: renderStartSuccess(result.start) })
  return { ok: true }
}

export const restartCommand = defineCommand({
  meta: {
    name: 'restart',
    description: 'stop and relaunch the agent container (host stage)',
  },
  args: {
    port: {
      type: 'string',
      description:
        'preferred host port; if it is already bound, typeclaw allocates a free ephemeral port and reports it',
      default: String(config.port),
    },
    build: {
      type: 'boolean',
      description: 'regenerate the Dockerfile from the latest template and rebuild the image',
      default: false,
    },
  },
  async run({ args }) {
    const cwd = findAgentDir(process.cwd()) ?? process.cwd()

    // Runs before BOTH isInitialized and stop. A wizard abort persists a
    // checkpoint before scaffold writes typeclaw.json, so a checkpoint-but-no-
    // config dir is an incomplete init that should get resume guidance, not the
    // generic config-missing error — and a half-init agent usually has no
    // container to stop. A `continue` falls through to isInitialized, which
    // still catches a truly uninitialized dir.
    const guard = await guardIncompleteInit({
      cwd,
      interactive: Boolean(process.stdout.isTTY),
      confirmContinue: async () => {
        const proceed = await confirm({ message: 'Try restarting anyway?', initialValue: false })
        return !isCancel(proceed) && proceed === true
      },
    })
    if (guard.action === 'block') {
      console.error(errorLine(guard.message))
      process.exit(1)
    }
    if (guard.action === 'abort') {
      process.exit(0)
    }

    if (!isInitialized(cwd)) {
      console.error(errorLine('TypeClaw config file not found. Run `typeclaw init` first.'))
      process.exit(1)
    }

    const validated = validateConfig(cwd)
    if (!validated.ok) {
      console.error(errorLine(validated.reason))
      process.exit(1)
    }
    reportConfigWarnings(validated.warnings)

    const preflight = await preflightDocker()
    if (!preflight.ok) {
      printDockerGuidance(preflight)
      process.exit(1)
    }

    const stopSpin = spinner()
    const controller = resolveController()
    let startSpin: ReturnType<typeof spinner> | undefined
    const result = await runRestartCommand(
      {
        cwd,
        preferredHostPort: Number(args.port),
        forceBuild: args.build,
        cliEntry: process.argv[1],
      },
      {
        restart: (restartOptions) => controller.restart(restartOptions),
        onEvent: (event) => {
          switch (event.kind) {
            case 'stop-spinner-start':
              stopSpin.start(event.message)
              break
            case 'stop-spinner-stop':
              stopSpin.stop(event.message)
              break
            case 'stop-spinner-error':
              stopSpin.error(event.message)
              break
            case 'start-spinner-start':
              startSpin = spinner()
              startSpin.start(event.message)
              break
            case 'start-spinner-stop':
              startSpin?.stop(event.message)
              break
            case 'start-spinner-error':
              startSpin?.error(event.message)
              break
            case 'warnings':
              reportConfigWarnings(event.warnings)
              break
            case 'success':
              console.log(event.output)
              break
          }
        },
      },
    )
    if (!result.ok) process.exit(1)
  },
})
