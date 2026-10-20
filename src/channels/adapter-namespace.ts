import type { AdapterId } from './schema'

// Only these account modes share platform user IDs. New/unlisted adapters
// retain their own namespace rather than accidentally linking identities.
const SHARED_NAMESPACES: Partial<Record<AdapterId, AdapterId>> = {
  'discord-bot': 'discord',
  'slack-bot': 'slack',
  'webex-bot': 'webex',
}

export function adapterNamespace(adapter: AdapterId): AdapterId {
  return SHARED_NAMESPACES[adapter] ?? adapter
}
