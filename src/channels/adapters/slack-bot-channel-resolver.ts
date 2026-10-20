import type { ChannelKey, ChannelNameResolver, ResolvedChannelNames } from '@/channels/types'

const SLACK_API_BASE = 'https://slack.com/api'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export type SlackChannelResolverOptions = {
  token: string
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
}

type CacheEntry<T> = { value: T; expiresAt: number }

type SlackConversationsInfoResponse = {
  ok: boolean
  channel?: { id?: string; name?: string }
}

type SlackTeamInfoResponse = {
  ok: boolean
  team?: { id?: string; name?: string }
}

export function createSlackChannelResolver(options: SlackChannelResolverOptions): ChannelNameResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS

  const chatCache = new Map<string, CacheEntry<string>>()
  const teamCache = new Map<string, CacheEntry<string>>()

  const fetchCached = async <T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    fetcher: () => Promise<T | null>,
  ): Promise<T | null> => {
    const cached = cache.get(key)
    if (cached && cached.expiresAt > now()) return cached.value
    const value = await fetcher()
    if (value !== null) cache.set(key, { value, expiresAt: now() + ttlMs })
    return value
  }

  return async (key: ChannelKey): Promise<ResolvedChannelNames> => {
    if (key.workspace === '@dm') return {}

    const [chatName, workspaceName] = await Promise.all([
      fetchCached(chatCache, key.chat, () => fetchChannelName(key.chat, options.token, options.fetchImpl ?? fetch)),
      fetchCached(teamCache, key.workspace, () =>
        fetchTeamName(key.workspace, options.token, options.fetchImpl ?? fetch),
      ),
    ])

    const result: ResolvedChannelNames = {}
    if (chatName !== null) result.chatName = chatName
    if (workspaceName !== null) result.workspaceName = workspaceName
    return result
  }
}

async function fetchChannelName(channelId: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${SLACK_API_BASE}/conversations.info?channel=${encodeURIComponent(channelId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as SlackConversationsInfoResponse
    if (!body.ok || !body.channel?.name) return null
    return body.channel.name
  } catch {
    return null
  }
}

async function fetchTeamName(teamId: string, token: string, fetchImpl: typeof fetch): Promise<string | null> {
  try {
    const response = await fetchImpl(`${SLACK_API_BASE}/team.info?team=${encodeURIComponent(teamId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return null
    const body = (await response.json()) as SlackTeamInfoResponse
    if (!body.ok || !body.team?.name) return null
    return body.team.name
  } catch {
    return null
  }
}
