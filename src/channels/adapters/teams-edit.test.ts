import { describe, expect, it } from 'bun:test'

import type { EditMessageRequest } from '@/channels/types'

import { createTeamsEditMessageCallback } from './teams-edit'
import { encodeTeamsChannelKey, encodeTeamsChatKey } from './teams-key'

class FakeTeamsError extends Error {
  constructor(public code: string) {
    super(code)
  }
}

const req = (over: Partial<EditMessageRequest> = {}): EditMessageRequest => ({
  adapter: 'teams',
  workspace: 'W1',
  chat: encodeTeamsChatKey('19:chatabc@thread.v2'),
  thread: null,
  messageId: '1700000000000',
  text: 'edited body',
  ...over,
})

describe('createTeamsEditMessageCallback', () => {
  it('decodes a chat key and calls editChatMessage with (chatId, messageId, content)', async () => {
    const calls: Array<{ chatId: string; messageId: string; content: string }> = []
    const cb = createTeamsEditMessageCallback({
      client: {
        editChatMessage: async (chatId, messageId, content) => {
          calls.push({ chatId, messageId, content })
          return { id: messageId, content } as never
        },
      },
    })

    const result = await cb(req())

    expect(result).toEqual({ ok: true })
    expect(calls).toEqual([{ chatId: '19:chatabc@thread.v2', messageId: '1700000000000', content: 'edited body' }])
  })

  // An edit replaces a message body, so it decides rendering exactly like a send
  // does; pin it to the same plain-text contract instead of the SDK default.
  it('passes format text so Teams markup in an edited body is not interpreted', async () => {
    const formats: Array<string | undefined> = []
    const cb = createTeamsEditMessageCallback({
      client: {
        editChatMessage: async (_chatId, messageId, content, format) => {
          formats.push(format)
          return { id: messageId, content } as never
        },
      },
    })

    await cb(req({ text: '<at id="0">Alice</at> compare 1 < 2 && 3 > 2' }))

    expect(formats).toEqual(['text'])
  })

  it('rejects a channel-keyed target as not-supported (SDK edits chats only)', async () => {
    let called = false
    const cb = createTeamsEditMessageCallback({
      client: {
        editChatMessage: async () => {
          called = true
          return {} as never
        },
      },
    })

    const result = await cb(req({ chat: encodeTeamsChannelKey('team-guid', '19:channel@thread.tacv2') }))

    expect(result).toEqual({ ok: false, error: 'Teams channel messages cannot be edited', code: 'not-supported' })
    expect(called).toBe(false)
  })

  it('rejects an undecodable conversation id as not-found', async () => {
    const cb = createTeamsEditMessageCallback({
      client: { editChatMessage: async () => ({}) as never },
    })

    const result = await cb(req({ chat: 'garbage' }))

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })

  it('rejects a mismatched adapter as not-supported', async () => {
    const cb = createTeamsEditMessageCallback({
      client: { editChatMessage: async () => ({}) as never },
    })

    const result = await cb(req({ adapter: 'slack' }))

    expect(result).toEqual({ ok: false, error: 'unknown adapter: slack', code: 'not-supported' })
  })

  it('maps a TeamsError http_403 code to permission-denied', async () => {
    const cb = createTeamsEditMessageCallback({
      client: {
        editChatMessage: async () => {
          throw new FakeTeamsError('http_403')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })

  it('maps a TeamsError token_expired code to permission-denied', async () => {
    const cb = createTeamsEditMessageCallback({
      client: {
        editChatMessage: async () => {
          throw new FakeTeamsError('token_expired')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('permission-denied')
  })

  it('maps a TeamsError http_404 code to not-found', async () => {
    const cb = createTeamsEditMessageCallback({
      client: {
        editChatMessage: async () => {
          throw new FakeTeamsError('http_404')
        },
      },
    })

    const result = await cb(req())

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('not-found')
  })
})
