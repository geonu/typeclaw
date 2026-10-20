import { classifyReviewClaim } from './github-review-claim'
import { hasResolvedThread, hasReview } from './github-review-turn-ledger'

// Decides whether a github PR reply is a false receipt: prose that CLAIMS a
// formal verdict / thread close-out the agent never actually performed this turn.
// Pure except for the ledger reads (module singletons); returns the action the
// channel_reply tool should take. Block only the black-and-white cases; warn on
// soft signals so casual chatter is never hard-denied.

export type FalseReceiptDecision =
  | { kind: 'allow' }
  | { kind: 'block'; reason: string }
  | { kind: 'warn'; notice: string }

export type FalseReceiptInput = {
  sessionId: string
  adapter: string
  workspace: string
  chat: string
  thread: string | null
  text: string | undefined
  continueAfterReply: boolean
  resolveReviewThread: boolean
}

export function checkFalseReceipt(input: FalseReceiptInput): FalseReceiptDecision {
  if (input.adapter !== 'github') return { kind: 'allow' }
  const prNumber = prNumberFromChat(input.chat)
  if (prNumber === null) return { kind: 'allow' }

  const claim = classifyReviewClaim(input.text ?? '')
  if (claim === 'ignore') return { kind: 'allow' }
  if (claim === 'warn') return { kind: 'warn', notice: SOFT_NOTICE }

  // A turn the agent explicitly keeps alive (continue_after_reply:true) is not yet
  // a receipt — the real action may still be coming. Never block; nudge instead.
  if (input.continueAfterReply) return { kind: 'warn', notice: SOFT_NOTICE }

  if (claim === 'block-resolve') {
    if (input.thread === null) return { kind: 'allow' }
    if (input.resolveReviewThread) return { kind: 'allow' }
    if (
      hasResolvedThread({
        sessionId: input.sessionId,
        workspace: input.workspace,
        prNumber,
        rootCommentId: input.thread,
      })
    ) {
      return { kind: 'allow' }
    }
    return { kind: 'block', reason: RESOLVE_REASON }
  }

  const verdict = claim === 'block-approve' ? 'APPROVE' : 'REQUEST_CHANGES'
  if (hasReview({ sessionId: input.sessionId, workspace: input.workspace, prNumber, verdict })) {
    return { kind: 'allow' }
  }
  return { kind: 'block', reason: verdict === 'APPROVE' ? APPROVE_REASON : REQUEST_CHANGES_REASON }
}

function prNumberFromChat(chat: string): number | null {
  const m = /^pr:(\d+)$/.exec(chat)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

const APPROVE_REASON =
  'This reply reads as a formal approval, but no APPROVE review was submitted on this PR this turn. ' +
  'A chat comment is not a GitHub review — submit the formal review via `gh api -X POST /repos/<owner>/<repo>/pulls/<N>/reviews` ' +
  '(event: APPROVE) first, then narrate if needed. If you are not actually approving, reword the reply.'

const REQUEST_CHANGES_REASON =
  'This reply reads as a formal "request changes", but no REQUEST_CHANGES review was submitted on this PR this turn. ' +
  'Submit the formal review via `gh api -X POST /repos/<owner>/<repo>/pulls/<N>/reviews` (event: REQUEST_CHANGES) first. ' +
  'If you are not actually requesting changes, reword the reply.'

const RESOLVE_REASON =
  'This reply reads as closing out a review thread, but `resolve_review_thread: true` was not set and the thread ' +
  'was not resolved this turn. Pass `resolve_review_thread: true` on this reply to actually resolve it, ' +
  'or reword if the thread should stay open.'

const SOFT_NOTICE =
  'Note: a chat comment does not create a formal GitHub review or resolve a thread. ' +
  'If you mean to approve / request changes, submit a formal review via `gh api`; ' +
  'to close a thread you authored, set `resolve_review_thread: true`.'
