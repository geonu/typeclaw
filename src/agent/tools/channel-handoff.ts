import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-coding-agent'

import type { ChannelHandoffResult, ChannelRouter } from '@/channels/router'
import { ADAPTER_IDS } from '@/channels/schema'

export type CreateChannelHandoffToolOptions = {
  router: Pick<ChannelRouter, 'handoff'>
  sessionId: string
}

// `channel_handoff` hands work to the session that owns another conversation
// instead of posting there with channel_send. A channel_send from here is
// written from THIS session's view of that conversation, which goes stale the
// moment people keep talking there; the owning session sees its latest
// messages and decides what (if anything) to post.
export function createChannelHandoffTool({ router, sessionId }: CreateChannelHandoffToolOptions) {
  return defineTool({
    name: 'channel_handoff',
    label: 'Channel Handoff',
    description:
      'Hand a result or a request to your own session in ANOTHER conversation (same adapter), instead of posting ' +
      'there with `channel_send`. Use it whenever the user asks you to continue, report back, or post something in a ' +
      'different channel/thread than this one — e.g. they moved to a DM for a private step and now say "continue" or ' +
      '"post it in #general". The session that owns that conversation receives your `text` as a private note from ' +
      'the user, reads its own latest messages, and then decides what to post, so newer requests there are not ' +
      'answered with a stale result. Your `text` is not posted verbatim: write what was done and what is left, ' +
      'not a finished channel message. It acts on behalf of the user who asked you this turn, with their permissions ' +
      'in the target conversation, and only reaches a conversation that user recently took part in. ' +
      'After a successful handoff, briefly tell the user here that it was passed on. ' +
      'Not available in a turn that was itself started by a handoff (reply with `channel_reply` there).',
    parameters: Type.Object({
      adapter: Type.Union(
        ADAPTER_IDS.map((a) => Type.Literal(a)),
        { description: "Target adapter id. Must be this conversation's adapter." },
      ),
      workspace: Type.String({
        description: 'Discord guild id or Slack team id; "@dm" for direct-message channels.',
        minLength: 1,
      }),
      chat: Type.String({ description: 'Target channel id.', minLength: 1 }),
      thread: Type.Optional(
        Type.String({
          description: 'Optional thread id (Discord thread channel id, Slack parent thread_ts).',
          minLength: 1,
        }),
      ),
      text: Type.String({
        description:
          'What the owning session needs to know: the request, what you already did, and the result. Plain context, not a ready-to-post message.',
        minLength: 1,
      }),
    }),

    async execute(_toolCallId, params) {
      const result: ChannelHandoffResult = await router.handoff({
        fromSessionId: sessionId,
        target: {
          adapter: params.adapter,
          workspace: params.workspace,
          chat: params.chat,
          thread: params.thread ?? null,
        },
        text: params.text,
      })
      const text = result.ok
        ? `Handed off to ${result.target}. That conversation's session will answer there with its current context; do not also post it yourself.`
        : `channel_handoff denied (${result.code}): ${result.error}`
      return { content: [{ type: 'text' as const, text }], details: result }
    },
  })
}
