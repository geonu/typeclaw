import { confirm, isCancel } from '@clack/prompts'
import { defineCommand } from 'citty'

import { config, validateConfig } from '@/config'
import { type Controller, resolveController } from '@/container'
import { findAgentDir, isInitialized } from '@/init'

import { preflightDocker, printDockerGuidance } from './docker-preflight'
import { guardIncompleteInit } from './incomplete-init'
import { errorLine, renderStartSuccess, reportConfigWarnings, spinner } from './ui'

export type StartCommandEvent =
  | { kind: 'spinner-start'; message: string }
  | { kind: 'spinner-stop'; message: string }
  | { kind: 'spinner-error'; message: string }
  | { kind: 'warnings'; warnings: string[] }
  | { kind: 'success'; output: string }

export type StartCommandDeps = {
  start: Controller['start']
  onEvent: (event: StartCommandEvent) => void
}

export async function runStartCommand(
  options: { cwd: string; preferredHostPort: number; forceBuild: boolean; cliEntry?: string },
  deps: StartCommandDeps,
): Promise<{ ok: boolean }> {
  deps.onEvent({ kind: 'spinner-start', message: 'Starting container...' })
  const warnings: string[] = []
  const result = await deps.start({
    ...options,
    onWarning: (warning) => warnings.push(warning),
  })
  if (!result.ok) {
    deps.onEvent({ kind: 'spinner-error', message: result.reason })
    deps.onEvent({ kind: 'warnings', warnings })
    return { ok: false }
  }

  deps.onEvent({ kind: 'spinner-stop', message: result.alreadyRunning ? 'Already running.' : 'Started.' })
  deps.onEvent({ kind: 'warnings', warnings })
  deps.onEvent({ kind: 'warnings', warnings: result.dockerfileWarnings })
  deps.onEvent({ kind: 'success', output: renderStartSuccess(result) })
  return { ok: true }
}

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'launch the agent container in the background (host stage)',
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

    // Runs BEFORE the isInitialized check: a wizard abort persists a checkpoint
    // before scaffold writes typeclaw.json, so a checkpoint-but-no-config dir is
    // an incomplete init, not a "never initialized" one. Guarding first means
    // that case gets the resume guidance instead of the generic config-missing
    // error. A `continue` (no incomplete checkpoint, or "try anyway") falls
    // through to isInitialized, which still catches a truly uninitialized dir.
    const guard = await guardIncompleteInit({
      cwd,
      interactive: Boolean(process.stdout.isTTY),
      confirmContinue: async () => {
        const proceed = await confirm({ message: 'Try starting anyway?', initialValue: false })
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

    const s = spinner()
    const controller = resolveController()
    const result = await runStartCommand(
      {
        cwd,
        preferredHostPort: Number(args.port),
        forceBuild: args.build,
        cliEntry: process.argv[1],
      },
      {
        start: (startOptions) => controller.start(startOptions),
        onEvent: (event) => {
          switch (event.kind) {
            case 'spinner-start':
              s.start(event.message)
              break
            case 'spinner-stop':
              s.stop(event.message)
              break
            case 'spinner-error':
              s.error(event.message)
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
