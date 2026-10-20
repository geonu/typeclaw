import { randomUUID } from 'node:crypto'

import type { ChannelParticipant, SessionOrigin } from '@/agent/session-origin'
import { CORE_PERMISSIONS, type PermissionService } from '@/permissions'

import type { AdapterId } from './schema'
import { channelKeyId, type ChannelKey, type InboundMessage, type RouteReceipt } from './types'

export type HandoffSession = {
  readonly sessionId: string
  readonly key: ChannelKey
  readonly keyId: string
  readonly destroyed: boolean
  readonly currentTurnHandoff: boolean
  readonly lastTurnHandoff: boolean
  readonly draining: boolean
  readonly currentTurnAuthorId: string | null
  readonly lastTurnAuthorId: string | null
  readonly currentTurnAuthorAdapter: AdapterId
  readonly lastTurnAuthorAdapter: AdapterId
  readonly participants: readonly ChannelParticipant[]
  readonly room?: InboundMessage['room']
  readonly lastInboundIsDm: boolean
}

export type ChannelHandoffResult =
  | { ok: true; target: string }
  | {
      ok: false
      code:
        | 'no-source-session'
        | 'loop'
        | 'same-conversation'
        | 'no-requester'
        | 'target-not-live'
        | 'requester-unknown-in-target'
        | 'would-elevate'
        | 'denied'
        | 'not-engaged'
      error: string
    }

type HandoffAccess =
  | {
      ok: true
      source: HandoffSession
      target: HandoffSession
      authorId: string
      authorAdapter: AdapterId
      authorName: string
    }
  | Extract<ChannelHandoffResult, { ok: false }>

export function findHandoffSource(sessions: ReadonlyMap<string, HandoffSession>, sessionId: string) {
  return [...sessions.values()].find((session) => session.sessionId === sessionId && !session.destroyed)
}

export function checkHandoffAccess(args: {
  source: HandoffSession | undefined
  target: HandoffSession | undefined
  permissions: PermissionService
}): HandoffAccess {
  const { source, target, permissions } = args
  if (source === undefined)
    return { ok: false, code: 'no-source-session', error: 'handoff requires a live source channel session' }
  if (source.currentTurnHandoff || (!source.draining && source.lastTurnHandoff))
    return { ok: false, code: 'loop', error: 'this turn was started by a handoff; answer with channel_reply' }
  if (target === undefined || target.destroyed)
    return { ok: false, code: 'target-not-live', error: 'no live session owns that conversation' }
  if (target.keyId === source.keyId)
    return { ok: false, code: 'same-conversation', error: 'target is this conversation; use channel_reply' }
  const authorId = source.currentTurnAuthorId ?? source.lastTurnAuthorId
  if (authorId === null)
    return { ok: false, code: 'no-requester', error: 'no authenticated requester to act on behalf of' }
  const authorAdapter =
    source.currentTurnAuthorId !== null ? source.currentTurnAuthorAdapter : source.lastTurnAuthorAdapter
  const origin = (session: HandoffSession): SessionOrigin => ({
    kind: 'channel',
    ...session.key,
    ...(session.room?.parentChat !== undefined ? { parentChat: session.room.parentChat } : {}),
    lastInboundAuthorId: authorId,
    lastInboundAuthorAdapter: authorAdapter,
  })
  const targetOrigin = origin(target)
  const targetRole = permissions.resolveRole(targetOrigin, { requireMatch: true })
  const targetPermissions = targetRole === undefined ? undefined : permissions.permissionsForRole(targetRole)
  if (targetPermissions === undefined)
    return {
      ok: false,
      code: 'requester-unknown-in-target',
      error: 'the authenticated requester has no matching known role in the target conversation',
    }
  const sourceRole = permissions.resolveRole(origin(source))
  const sourcePermissions = permissions.permissionsForRole(sourceRole)
  if (
    sourcePermissions === undefined ||
    targetPermissions.some((permission) => !sourcePermissions.includes(permission))
  )
    return {
      ok: false,
      code: 'would-elevate',
      error: 'the target grants authority the requester does not hold in the source; request there directly',
    }
  if (!permissions.has(targetOrigin, CORE_PERMISSIONS.channelRespond))
    return { ok: false, code: 'denied', error: 'the requester cannot engage the agent in the target conversation' }
  // Capability dominance already bounds every accepted handoff, including
  // owners. Recent participation adds no authority proof and blocks legitimate
  // work across accounts or after an idle period.
  return {
    ok: true,
    source,
    target,
    authorId,
    authorAdapter,
    authorName: source.participants.find((participant) => participant.authorId === authorId)?.authorName ?? authorId,
  }
}

export function createSessionHandoff(options: {
  sessions: ReadonlyMap<string, HandoffSession>
  permissions: PermissionService
  route: (event: InboundMessage) => Promise<RouteReceipt>
  logger: { info: (message: string) => void }
  now: () => number
}) {
  return async (args: { fromSessionId: string; target: ChannelKey; text: string }): Promise<ChannelHandoffResult> => {
    const targetId = channelKeyId(args.target)
    const access = checkHandoffAccess({
      source: findHandoffSource(options.sessions, args.fromSessionId),
      target: options.sessions.get(targetId),
      permissions: options.permissions,
    })
    if (!access.ok) {
      options.logger.info(`[channels] handoff ${args.fromSessionId} -> ${targetId}: refused ${access.code}`)
      return access
    }
    const { source, target } = access
    const fromWhere = source.lastInboundIsDm ? 'a private DM' : `another conversation (${source.keyId})`
    const receipt = await options.route({
      ...target.key,
      ...(target.room !== undefined ? { room: target.room } : {}),
      routingNote:
        `[handoff: ${access.authorName} asked you for this in ${fromWhere}. It was NOT posted in this conversation and nobody ` +
        "here has seen it. Read this conversation's latest messages first: if someone has since asked for something newer " +
        'or the result below is outdated, act on the current state instead of repeating it, or stay silent if nothing is ' +
        'needed. Share only what this conversation needs, not private details.]',
      handoff: true,
      text: args.text,
      externalMessageId: `handoff:${randomUUID()}`,
      eventKind: 'handoff',
      authorId: access.authorId,
      authorAdapter: access.authorAdapter,
      authorName: access.authorName,
      authorIsBot: false,
      isBotMention: true,
      suppressSticky: true,
      replyToBotMessageId: null,
      mentionsOthers: false,
      replyToOtherMessageId: null,
      isDm: target.lastInboundIsDm,
      ts: options.now(),
    })
    options.logger.info(`[channels] handoff ${source.keyId} -> ${targetId}: ${receipt.kind}`)
    switch (receipt.kind) {
      case 'accepted':
      case 'duplicate':
        return { ok: true, target: targetId }
      case 'denied':
        return { ok: false, code: 'denied', error: 'target authorization changed or its adapter is unavailable' }
      case 'observed':
      case 'control':
        return { ok: false, code: 'not-engaged', error: 'the target did not accept the handoff' }
    }
  }
}
