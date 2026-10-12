import type { SessionOrigin } from './session-origin'

// Mirrors pi-ai's OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, which pi applies before
// `onPayload` runs, so a replaced key must be bounded here too. Truncation can
// only merge two long-named origins into one cache bucket, which is harmless.
const PROMPT_CACHE_KEY_MAX_LENGTH = 64

// pi defaults OpenAI's `prompt_cache_key` to the session id, and OpenAI routes
// requests to cache machines by that key. Every new subagent/cron/channel
// session therefore landed on a cold machine and re-paid its whole ~10K-token
// system+tools prefix even though sibling sessions of the same kind had just
// sent the identical prefix. Keying by origin kind (and subagent/component
// name, whose prompts differ) lets those sessions share the warm prefix. Only
// the body key changes: pi still uses the session id for the Codex websocket
// session cache and request headers.
export function promptCacheKeyForOrigin(origin: SessionOrigin | undefined): string | undefined {
  const key = unboundedPromptCacheKey(origin)
  return key === undefined ? undefined : Array.from(key).slice(0, PROMPT_CACHE_KEY_MAX_LENGTH).join('')
}

function unboundedPromptCacheKey(origin: SessionOrigin | undefined): string | undefined {
  if (origin === undefined) return undefined
  switch (origin.kind) {
    case 'subagent':
      return `typeclaw:subagent:${origin.subagent}`
    case 'system':
      return `typeclaw:system:${origin.component}`
    case 'tui':
    case 'cron':
    case 'channel':
      return `typeclaw:${origin.kind}`
  }
}

// Rewrites only payloads that already carry a string `prompt_cache_key`, so
// providers without the field and `cacheRetention: 'none'` (which omits it)
// are left untouched.
export function withPromptCacheKey(payload: unknown, key: string): unknown {
  if (typeof payload !== 'object' || payload === null) return payload
  if (typeof (payload as { prompt_cache_key?: unknown }).prompt_cache_key !== 'string') return payload
  return { ...payload, prompt_cache_key: key }
}
