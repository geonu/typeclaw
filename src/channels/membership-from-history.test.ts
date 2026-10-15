import { describe, expect, test } from 'bun:test'

import { countAuthors, deriveMembershipFromHistory } from './membership-from-history'
import type { ChannelHistoryMessage, FetchHistoryResult } from './types'

function msg(
  over: Partial<ChannelHistoryMessage> & Pick<ChannelHistoryMessage, 'authorId' | 'isBot'>,
): ChannelHistoryMessage {
  return {
    externalMessageId: over.externalMessageId ?? `m-${over.authorId}-${Math.random()}`,
    authorId: over.authorId,
    authorName: over.authorName ?? over.authorId,
    text: over.text ?? '',
    ts: over.ts ?? 0,
    isBot: over.isBot,
    replyToBotMessageId: over.replyToBotMessageId ?? null,
  }
}

describe('countAuthors', () => {
  test('empty history returns zero counts (not a failure)', () => {
    expect(countAuthors([], 100)).toEqual({ humans: 0, bots: 0, fetchedAt: 100, truncated: true })
  })

  test('dedupes by author id and splits humans/bots', () => {
    const result = countAuthors(
      [
        msg({ authorId: 'alice', isBot: false }),
        msg({ authorId: 'alice', isBot: false }),
        msg({ authorId: 'bot1', isBot: true }),
        msg({ authorId: 'bob', isBot: false }),
        msg({ authorId: 'bot1', isBot: true }),
      ],
      200,
    )
    expect(result).toEqual({ humans: 2, bots: 1, fetchedAt: 200, truncated: true })
  })

  test('first occurrence wins on classification disagreement (data-glitch resilience)', () => {
    const result = countAuthors([msg({ authorId: 'flip', isBot: false }), msg({ authorId: 'flip', isBot: true })], 0)
    expect(result).toEqual({ humans: 1, bots: 0, fetchedAt: 0, truncated: true })
  })
})

describe('deriveMembershipFromHistory', () => {
  test('maps a successful fetch into a truncated count', async () => {
    const fetchHistory = async (): Promise<FetchHistoryResult> => ({
      ok: true,
      messages: [
        msg({ authorId: 'alice', isBot: false }),
        msg({ authorId: 'penpen', isBot: true }),
        msg({ authorId: 'arti', isBot: true }),
      ],
    })
    const result = await deriveMembershipFromHistory({ fetchHistory, now: () => 999 })
    expect(result).toEqual({ humans: 1, bots: 2, fetchedAt: 999, truncated: true })
  })

  test('history failure returns transient (cache retries soon)', async () => {
    const fetchHistory = async (): Promise<FetchHistoryResult> => ({ ok: false, error: 'boom' })
    const result = await deriveMembershipFromHistory({ fetchHistory, now: () => 0 })
    expect(result).toEqual({ kind: 'transient' })
  })
})
