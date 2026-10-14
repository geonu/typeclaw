import { join } from 'node:path'

import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

import { createSecretsStoreForAgent } from './storage'

/** Runtime-only value. Never serialize this into a tool receipt or child configuration. */
export type CodingAgentProvider = 'anthropic' | 'openai-codex'
export type CodingAgentAuth = {
  readonly token: string
  readonly secrets: readonly string[]
} & (
  | { readonly provider?: 'anthropic'; readonly type: 'api_key' | 'oauth' }
  | { readonly provider: 'openai-codex'; readonly type: 'oauth'; readonly accountId: string }
)

export class CodingAgentAuthError extends Error {
  constructor(provider: CodingAgentProvider) {
    super(
      `${provider} authentication is unavailable. On the host, run \`typeclaw provider add ${provider}\`, then retry this task.`,
    )
  }
}

export type CodingAgentAuthResolver = {
  resolve(signal?: AbortSignal, rejected?: CodingAgentAuth, provider?: CodingAgentProvider): Promise<CodingAgentAuth>
}

export async function createCodingAgentAuthResolver(
  agentDir: string,
  dependencies?: { credentials: CredentialStore; runtime: ModelRuntime },
): Promise<CodingAgentAuthResolver> {
  const credentials = dependencies?.credentials ?? createSecretsStoreForAgent(join(agentDir, 'secrets.json'))
  const runtime =
    dependencies?.runtime ?? (await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false }))

  return {
    async resolve(signal, rejected, provider = 'anthropic') {
      try {
        // Invalidate only the rejected generation, under the SAME lock used by pi.
        // A concurrent refresh or host re-login must never be overwritten.
        if (rejected?.provider === provider && rejected.type === 'oauth') {
          await credentials.modify(
            provider,
            async (current) => {
              if (current?.type === 'oauth' && current.access === rejected.token) {
                return { ...current, expires: 0 }
              }
              return undefined
            },
            { signal },
          )
        }
        const stored = await credentials.read(provider, { signal })
        // Subscription delegation must never fall back to separately billed API auth.
        if (provider === 'openai-codex' && stored?.type !== 'oauth') throw new CodingAgentAuthError(provider)
        const resolved = await runtime.getAuth(provider, {
          signal,
          // Persisted OAuth wins over ambient API keys, as on the main-agent path.
          ...(stored?.type === 'oauth' || dependencies ? { env: {} } : {}),
        })
        if (!resolved?.auth.apiKey) throw new CodingAgentAuthError(provider)
        const token = resolved.auth.apiKey
        const current = await credentials.read(provider, { signal })
        const secrets = [token, ...credentialSecrets(stored), ...credentialSecrets(current)].filter(Boolean)
        if (provider === 'openai-codex') {
          // Bind the account to the exact resolved token generation, not a racing re-login.
          const credential = [current, stored].find((value) => value?.type === 'oauth' && value.access === token)
          if (
            credential?.type !== 'oauth' ||
            typeof credential.accountId !== 'string' ||
            !/^[\x21-\x7e]+$/.test(credential.accountId)
          )
            throw new CodingAgentAuthError(provider)
          return { provider, type: 'oauth', token, accountId: credential.accountId, secrets }
        }
        return {
          provider,
          type: current?.type === 'oauth' ? 'oauth' : 'api_key',
          token,
          secrets,
        }
      } catch {
        // OAuth transports can include token endpoint bodies in their errors.
        throw new CodingAgentAuthError(provider)
      }
    },
  }
}

function credentialSecrets(credential: Credential | undefined): string[] {
  if (credential?.type !== 'oauth') return []
  return [credential.access, credential.refresh, credential.idToken, credential.id_token].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
}
