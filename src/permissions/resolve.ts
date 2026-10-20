import { adapterNamespace } from '@/channels/adapter-namespace'
import { decodeWebexId } from '@/channels/adapters/webex-id-ref'
import type { AdapterId } from '@/channels/schema'

import type { MatchRule, Platform } from './match-rule'

const ADAPTER_TO_PLATFORM: Record<AdapterId, Platform> = {
  slack: 'slack',
  'slack-bot': 'slack',
  discord: 'discord',
  'discord-bot': 'discord',
  github: 'github',
  instagram: 'instagram',
  'telegram-bot': 'telegram',
  webex: 'webex',
  'webex-bot': 'webex',
  teams: 'teams',
  line: 'line',
  kakaotalk: 'kakao',
}

export type MatchableOrigin =
  | { kind: 'tui'; sessionId?: string }
  | { kind: 'cron'; jobId?: string }
  | { kind: 'subagent'; subagent?: string }
  | {
      kind: 'channel'
      adapter: AdapterId
      workspace: string
      chat: string
      parentChat?: string
      lastInboundAuthorId?: string
      lastInboundAuthorAdapter?: AdapterId
    }

export function matchesOrigin(rule: MatchRule, origin: MatchableOrigin): boolean {
  switch (rule.kind) {
    case 'wildcard':
      return origin.kind === 'channel'
    case 'tui':
      return origin.kind === 'tui'
    case 'cron':
      return origin.kind === 'cron'
    case 'subagent':
      if (origin.kind !== 'subagent') return false
      if (rule.subagent === undefined) return true
      return origin.subagent === rule.subagent
    case 'channel':
      return matchesChannel(rule, origin)
  }
}

function matchesChannel(rule: Extract<MatchRule, { kind: 'channel' }>, origin: MatchableOrigin): boolean {
  if (origin.kind !== 'channel') return false
  if (ADAPTER_TO_PLATFORM[origin.adapter] !== rule.platform) return false

  if (rule.bucket !== undefined) {
    if (!matchesBucket(rule.bucket, origin)) return false
    if (rule.chat !== undefined && !matchesChat(rule.chat, origin)) return false
  } else {
    if (rule.workspace !== undefined && rule.workspace !== origin.workspace) return false
    if (rule.chat !== undefined && !matchesChat(rule.chat, origin)) return false
  }

  if (rule.author !== undefined) {
    if (adapterNamespace(origin.lastInboundAuthorAdapter ?? origin.adapter) !== adapterNamespace(origin.adapter))
      return false
    if (!matchesAuthor(rule.platform, rule.author, origin.lastInboundAuthorId)) return false
  }
  return true
}

function matchesChat(ruleChat: string, origin: Extract<MatchableOrigin, { kind: 'channel' }>): boolean {
  if (ruleChat === origin.chat) return true
  return ADAPTER_TO_PLATFORM[origin.adapter] === 'discord' && ruleChat === origin.parentChat
}

// Webex person ids are base64(`ciscospark://<cluster>/PEOPLE/<uuid-or-email>`),
// so a hand-authored or claim-generated rule may carry the raw base64 id, its
// decoded ref (UUID for modern accounts, email for legacy Hydra accounts), and
// the inbound may arrive as either. We compare on the decoded PERSON ref when
// BOTH sides decode to a PEOPLE id, and otherwise fall back to raw equality —
// so `author:<uuid>`, `author:<legacy-email>`, and the legacy `author:<base64>`
// all match the same human. A value that decodes to a non-PERSON type (e.g. a
// room id pasted into `author:`) never normalizes, so it can only ever raw-
// match — a room uuid can never satisfy an author rule.
function matchesAuthor(platform: Platform, ruleAuthor: string, inboundAuthorId: string | undefined): boolean {
  if (inboundAuthorId === undefined) return false
  if (ruleAuthor === inboundAuthorId) return true
  if (platform !== 'webex') return false
  // Both sides must resolve to a real PERSON ref. `webexPersonRef` returns null
  // for any non-PEOPLE id, and null === null would otherwise let two different
  // room/message ids satisfy an `author:` rule — so require both non-null.
  const ruleRef = webexPersonRef(ruleAuthor)
  const inboundRef = webexPersonRef(inboundAuthorId)
  return ruleRef !== null && inboundRef !== null && ruleRef === inboundRef
}

// Returns the comparable person identity for a Webex `author:` value: the
// decoded trailing ref when the value is a base64 PEOPLE id, or the value
// itself when it is already a ref (bare uuid/email). Returns null for anything
// that decodes to a non-PERSON Webex id, so two different resource types can
// never be coerced into matching. Emails are lower-cased so case variation in
// a legacy-account ref does not silently deny a grant. Keep this for backward
// compatibility with pre-migration rules that still carry blob-form ids.
function webexPersonRef(value: string): string | null {
  const decoded = decodeWebexId(value)
  if (decoded === null) return value.includes('@') ? value.toLowerCase() : value
  if (decoded.type !== 'PEOPLE') return null
  return decoded.uuid.includes('@') ? decoded.uuid.toLowerCase() : decoded.uuid
}

// DM and group buckets are inferred from the workspace/chat shape of the
// inbound origin. Different adapters mark DMs differently — Slack and Webex
// use an `@dm` workspace marker, Discord uses a `dm` workspace marker, and
// KakaoTalk preserves group/open/dm explicitly in its workspace field. We
// keep the heuristic narrow: a rule that says `slack:dm/*` matches only when
// the origin's workspace is `@dm` (Slack/Webex) or `dm` (Discord). KakaoTalk
// uses the workspace prefix itself.
function matchesBucket(
  bucket: 'dm' | 'group' | 'open' | 'square',
  origin: Extract<MatchableOrigin, { kind: 'channel' }>,
): boolean {
  const platform = ADAPTER_TO_PLATFORM[origin.adapter]
  if (platform === 'line') {
    if (bucket === 'dm') return origin.workspace === '@line-dm'
    if (bucket === 'group') return origin.workspace === '@line-group'
    if (bucket === 'square') return origin.workspace === '@line-square'
    return false
  }
  if (platform === 'kakao') {
    if (bucket === 'dm') return origin.workspace === '@kakao-dm'
    if (bucket === 'group') return origin.workspace === '@kakao-group'
    if (bucket === 'open') return origin.workspace === '@kakao-open'
    return false
  }
  if (bucket !== 'dm') return false
  if (platform === 'slack') return origin.workspace === '@dm'
  if (platform === 'discord') return origin.workspace === 'dm' || origin.workspace === '@dm'
  if (platform === 'telegram') return origin.workspace === 'dm' || origin.workspace.startsWith('@')
  if (platform === 'webex') return origin.workspace === '@dm'
  return false
}

// True only for a 1:1 direct-message channel origin (a two-participant
// conversation: the principal + the bot). Reuses the same per-adapter
// workspace markers as the `dm` match-rule bucket. A DM is the only channel
// shape with no third-party content buffered into a turn, so role-grant tools
// treat an owner/trusted DM as injection-equivalent to the TUI; group/open
// channels never qualify.
export function isDmChannelOrigin(origin: { adapter: AdapterId; workspace: string }): boolean {
  return matchesBucket('dm', { kind: 'channel', adapter: origin.adapter, workspace: origin.workspace, chat: '' })
}
