import type { SessionOrigin } from '@/agent/session-origin'
import { parseMatchRule, type MatchRule } from '@/permissions/match-rule'
import { matchesOrigin } from '@/permissions/resolve'

import type { Config, Models, ProfileEntry } from './config'

type ChannelOrigin = Extract<SessionOrigin, { kind: 'channel' }>

// The `models` map a session resolves profiles against: the global block with
// every matching `modelOverrides` entry layered on top. Per profile, the most
// specific matching rule wins (chat > workspace/bucket > platform > `*`), the
// later-declared entry on a tie; profiles no matching entry defines keep their
// global value. Subagents use the channel that (transitively) spawned them, so a
// chat's `fast`/`deep` also apply to its workers. TUI and cron stay global.
export function effectiveModels(
  cfg: Pick<Config, 'models' | 'modelOverrides'>,
  origin: SessionOrigin | undefined,
): Models {
  const channel = channelOf(origin)
  if (channel === undefined) return cfg.models
  const winners = new Map<string, { entry: ProfileEntry; specificity: number }>()
  for (const override of Object.values(cfg.modelOverrides)) {
    const specificity = matchSpecificity(override.match, channel)
    if (specificity === undefined) continue
    for (const [profile, entry] of Object.entries(override.models)) {
      const current = winners.get(profile)
      if (current === undefined || specificity >= current.specificity) winners.set(profile, { entry, specificity })
    }
  }
  if (winners.size === 0) return cfg.models
  const merged: Record<string, ProfileEntry> = { ...cfg.models }
  for (const [profile, { entry }] of winners) merged[profile] = entry
  return merged as Models
}

function channelOf(origin: SessionOrigin | undefined): ChannelOrigin | undefined {
  let current = origin
  while (current?.kind === 'subagent') current = current.spawnedByOrigin
  return current?.kind === 'channel' ? current : undefined
}

// Highest specificity among the rules that match, or undefined when none do.
function matchSpecificity(rules: readonly string[], channel: ChannelOrigin): number | undefined {
  let best: number | undefined
  for (const raw of rules) {
    const parsed = parseMatchRule(raw)
    if (!parsed.ok || !matchesOrigin(parsed.value, channel)) continue
    const specificity = ruleSpecificity(parsed.value)
    if (best === undefined || specificity > best) best = specificity
  }
  return best
}

function ruleSpecificity(rule: MatchRule): number {
  if (rule.kind !== 'channel') return 0
  if (rule.chat !== undefined) return 3
  if (rule.workspace !== undefined || rule.bucket !== undefined) return 2
  return 1
}
