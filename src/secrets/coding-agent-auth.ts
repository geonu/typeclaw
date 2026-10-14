import { join } from 'node:path'

import type { CredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { createSecretsStoreForAgent } from './storage'

/** Runtime-only value. Never serialize this into a tool receipt or child configuration. */
export type CodingAgentAuth = {
  readonly type: 'api_key' | 'oauth'
  readonly token: string
  readonly secrets: readonly string[]
}

export class CodingAgentAuthError extends Error {
  constructor() {
    super(
      'Anthropic authentication is unavailable. On the host, run `typeclaw provider add anthropic`, then retry this task.',
    )
  }
}

export type CodingAgentAuthResolver = {
  resolve(signal?: AbortSignal, rejected?: CodingAgentAuth): Promise<CodingAgentAuth>
}

export async function createCodingAgentAuthResolver(
  agentDir: string,
  dependencies?: { credentials: CredentialStore; runtime: ModelRuntime },
): Promise<CodingAgentAuthResolver> {
  const credentials = dependencies?.credentials ?? createSecretsStoreForAgent(join(agentDir, 'secrets.json'))
  const runtime =
    dependencies?.runtime ?? (await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false }))

  return {
    async resolve(signal, rejected) {
      try {
        // Invalidate only the rejected generation, under the SAME lock used by pi.
        // A concurrent refresh or host re-login must never be overwritten.
        if (rejected?.type === 'oauth') {
          await credentials.modify(
            'anthropic',
            async (current) => {
              if (current?.type === 'oauth' && current.access === rejected.token) {
                return { ...current, expires: 0 }
              }
              return undefined
            },
            { signal },
          )
        }
        const stored = await credentials.read('anthropic', { signal })
        const resolved = await runtime.getAuth('anthropic', {
          signal,
          // Persisted OAuth wins over ambient API keys, as on the main-agent path.
          ...(stored?.type === 'oauth' || dependencies ? { env: {} } : {}),
        })
        if (!resolved?.auth.apiKey) throw new CodingAgentAuthError()
        const current = await credentials.read('anthropic', { signal })
        return {
          type: current?.type === 'oauth' ? 'oauth' : 'api_key',
          token: resolved.auth.apiKey,
          secrets: [
            resolved.auth.apiKey,
            ...(stored?.type === 'oauth' ? [stored.access, stored.refresh] : []),
            ...(current?.type === 'oauth' ? [current.access, current.refresh] : []),
          ].filter(Boolean),
        }
      } catch {
        // OAuth transports can include token endpoint bodies in their errors.
        throw new CodingAgentAuthError()
      }
    },
  }
}
