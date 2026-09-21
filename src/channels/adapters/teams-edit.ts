import type { TeamsClient } from 'agent-messenger/teams'

import type { EditMessageCallback, EditMessageResult } from '@/channels/types'

import { describeError } from '../describe-error'
import { TEAMS_OUTBOUND_FORMAT } from './teams-format'
import { decodeTeamsConversationKey } from './teams-key'

// The Teams user-account SDK only exposes an edit primitive for 1:1/group
// chats (`PUT /users/ME/conversations/{chatId}/messages/{messageId}`); there is
// no equivalent for team/channel posts. So a channel-keyed edit is genuinely
// `not-supported`, distinct from an undecodable id (soft `not-found`).
export function createTeamsEditMessageCallback(deps: {
  client: Pick<TeamsClient, 'editChatMessage'>
}): EditMessageCallback {
  return async (req): Promise<EditMessageResult> => {
    if (req.adapter !== 'teams') {
      return { ok: false, error: `unknown adapter: ${req.adapter}`, code: 'not-supported' }
    }
    const decoded = decodeTeamsConversationKey(req.chat)
    if (decoded === null) {
      return { ok: false, error: `unsupported Teams conversation id: ${req.chat}`, code: 'not-found' }
    }
    if (decoded.kind !== 'chat') {
      return { ok: false, error: 'Teams channel messages cannot be edited', code: 'not-supported' }
    }
    try {
      await deps.client.editChatMessage(decoded.chatId, req.messageId, req.text, TEAMS_OUTBOUND_FORMAT)
    } catch (err) {
      return { ok: false, error: describeError(err), code: classifyEditError(err) }
    }
    return { ok: true }
  }
}

// TeamsError carries its identifier on `.code` (a string), not a numeric
// `.status`: the request path throws `TeamsError(msg, errorBody.code ?? http_<status>)`,
// so a forbidden edit surfaces as `http_403`/`http_401` and an auth failure as
// `token_expired`/`not_authenticated`. Everything else (e.g. `http_404` for a
// gone/foreign message) is a soft miss.
function classifyEditError(err: unknown): NonNullable<(EditMessageResult & { ok: false })['code']> {
  switch (errorCode(err)) {
    case 'http_403':
    case 'http_401':
    case 'token_expired':
    case 'not_authenticated':
      return 'permission-denied'
    default:
      return 'not-found'
  }
}

function errorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}
