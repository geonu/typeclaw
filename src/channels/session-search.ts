import type { PermissionService } from '@/permissions'

import { adapterNamespace } from './adapter-namespace'
import type { ConfigForAdapter } from './router'
import { checkHandoffAccess, findHandoffSource, type HandoffSession } from './session-handoff'
import type { ChannelKey, ResolvedChannelNames } from './types'

export type SessionActivity = { readonly text: string; readonly at: number }
export type SearchableSession = HandoffSession & {
  readonly resolvedNames: ResolvedChannelNames
  readonly recentMessages: readonly SessionActivity[]
  readonly lastInboundAt: number
}

export type SessionSearchTarget = {
  readonly target: ChannelKey
  readonly name: string
  readonly activity: string
  readonly lastActiveAt: number
}

export type SessionSearchArgs = {
  readonly fromSessionId: string
  readonly query: string
  // Used by channel_read to disambiguate platform-local conversation IDs.
  readonly conversation?: ChannelKey
}

export function createSessionSearch(options: {
  sessions: ReadonlyMap<string, SearchableSession>
  permissions: PermissionService
  configForAdapter: ConfigForAdapter
}) {
  return (args: SessionSearchArgs): SessionSearchTarget[] => {
    const source = findHandoffSource(options.sessions, args.fromSessionId)
    const query = args.query.trim().toLocaleLowerCase()
    const results: SessionSearchTarget[] = []
    for (const session of options.sessions.values()) {
      if (!options.configForAdapter(session.key.adapter)?.enabled) continue
      const conversation = args.conversation
      if (
        conversation !== undefined &&
        (session.key.adapter === conversation.adapter ||
          adapterNamespace(session.key.adapter) !== adapterNamespace(conversation.adapter) ||
          session.key.workspace !== conversation.workspace ||
          session.key.chat !== conversation.chat ||
          session.key.thread !== conversation.thread)
      )
        continue
      if (!checkHandoffAccess({ source, target: session, permissions: options.permissions }).ok) continue
      const name = session.resolvedNames.chatName ?? session.key.chat
      const values = [
        name,
        session.resolvedNames.workspaceName ?? session.key.workspace,
        session.room?.parentChatName ?? '',
        session.keyId,
        ...session.participants.flatMap((participant) => [participant.authorId, participant.authorName]),
        ...session.recentMessages.map((message) => message.text),
      ]
      if (!values.some((value) => value.toLocaleLowerCase().includes(query))) continue
      const latest = session.recentMessages.at(-1)
      results.push({
        target: { ...session.key },
        name,
        activity: latest?.text.replace(/\s+/gu, ' ').slice(0, 160) ?? '',
        lastActiveAt: latest?.at ?? session.lastInboundAt,
      })
    }
    return results.sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 20)
  }
}
