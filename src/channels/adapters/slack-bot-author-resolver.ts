const SLACK_API_BASE = 'https://slack.com/api'
const DEFAULT_TTL_MS = 60 * 60 * 1000

export type SlackAuthorResolverOptions = {
  token: string
  fetchImpl?: typeof fetch
  now?: () => number
  ttlMs?: number
}

export type SlackAuthorResolver = {
  resolve: (userId: string) => Promise<string>
}

type CacheEntry = { name: string; expiresAt: number }

type SlackUsersInfoResponse = {
  ok: boolean
  user?: {
    id?: string
    name?: string
    real_name?: string
    profile?: {
      display_name?: string
      real_name?: string
    }
  }
}

export function createSlackAuthorResolver(options: SlackAuthorResolverOptions): SlackAuthorResolver {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cache = new Map<string, CacheEntry>()
  const inflight = new Map<string, Promise<string>>()

  const resolve = async (userId: string): Promise<string> => {
    const cached = cache.get(userId)
    if (cached && cached.expiresAt > now()) return cached.name

    const existing = inflight.get(userId)
    if (existing) return existing

    const promise = fetchUserName(userId, options.token, options.fetchImpl ?? fetch)
      .then((name) => {
        if (name !== userId) {
          cache.set(userId, { name, expiresAt: now() + ttlMs })
        }
        return name
      })
      .finally(() => {
        inflight.delete(userId)
      })

    inflight.set(userId, promise)
    return promise
  }

  return { resolve }
}

async function fetchUserName(userId: string, token: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const response = await fetchImpl(`${SLACK_API_BASE}/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) return userId
    const body = (await response.json()) as SlackUsersInfoResponse
    if (!body.ok || !body.user) return userId
    return pickDisplayName(body.user) ?? userId
  } catch {
    return userId
  }
}

function pickDisplayName(user: NonNullable<SlackUsersInfoResponse['user']>): string | null {
  const candidates = [user.profile?.display_name, user.profile?.real_name, user.real_name, user.name]
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return c
  }
  return null
}
