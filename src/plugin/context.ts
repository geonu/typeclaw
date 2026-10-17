import type { ResolveGithubTokenForRepo } from '@/channels/github-token-bridge'
import type { PermissionService } from '@/permissions'

import type { PluginContext, PluginLogger, SpawnSubagentOptions } from './types'

export type SpawnSubagentFn = (name: string, payload?: unknown, options?: SpawnSubagentOptions) => Promise<void>

export type CreatePluginContextOptions<TConfig> = {
  name: string
  version: string | undefined
  agentDir: string
  config: TConfig
  logger: PluginLogger
  permissions: PermissionService
  resolveGithubTokenForRepo?: ResolveGithubTokenForRepo
  hasGithubAppTokenResolver?: () => boolean
  getGithubAppSelfLogin?: () => string | null
  resolveGithubPatForRepo?: ResolveGithubTokenForRepo
  spawnSubagent: SpawnSubagentFn
  isBooted: () => boolean
}

const githubTokenUnavailable: ResolveGithubTokenForRepo = async () => ({
  kind: 'unavailable',
  reason: 'GitHub token resolution is not wired in this context.',
})

export function createPluginContext<TConfig>(opts: CreatePluginContextOptions<TConfig>): PluginContext<TConfig> {
  return Object.freeze({
    name: opts.name,
    version: opts.version,
    agentDir: opts.agentDir,
    config: opts.config,
    logger: opts.logger,
    permissions: opts.permissions,
    github: {
      resolveTokenForRepo: opts.resolveGithubTokenForRepo ?? githubTokenUnavailable,
      hasAppTokenResolver: opts.hasGithubAppTokenResolver ?? (() => false),
      getAppSelfLogin: opts.getGithubAppSelfLogin ?? (() => null),
      resolvePatForRepo: opts.resolveGithubPatForRepo ?? githubTokenUnavailable,
    },
    spawnSubagent: async (name: string, payload?: unknown, options?: SpawnSubagentOptions) => {
      if (!opts.isBooted()) {
        throw new Error(
          `plugin ${opts.name}: spawnSubagent("${name}") called before boot completed; subagent registry is not yet wired`,
        )
      }
      await opts.spawnSubagent(name, payload, options)
    },
  })
}

export function createPluginLogger(name: string): PluginLogger {
  const prefix = `[plugin:${name}]`
  return {
    info: (m) => console.log(`${prefix} ${m}`),
    warn: (m) => console.warn(`${prefix} ${m}`),
    error: (m) => console.error(`${prefix} ${m}`),
  }
}
