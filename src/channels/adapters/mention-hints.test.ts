import { describe, expect, test } from 'bun:test'

import { addDiscordMentionHints, addSlackMentionHints, extractMentionedUserIds } from './mention-hints'

describe('addSlackMentionHints', () => {
  const resolver = (names: Record<string, string>) => async (id: string) => names[id] ?? id

  test('appends a display-name hint after the bare mention token', async () => {
    const out = await addSlackMentionHints("Yo <@U0B4JR0KPFH>, what's up?", resolver({ U0B4JR0KPFH: 'johndoe' }))
    expect(out).toBe("Yo <@U0B4JR0KPFH> (johndoe), what's up?")
  })

  test('labels the bot’s own mention as (you)', async () => {
    const out = await addSlackMentionHints('hey <@UBOT> here', resolver({ UBOT: 'Momo' }), { botUserId: 'UBOT' })
    expect(out).toBe('hey <@UBOT> (you) here')
  })

  test('leaves the token unchanged when the name cannot be resolved', async () => {
    // SlackAuthorResolver echoes the id back on lookup failure; an empty map mimics that
    const out = await addSlackMentionHints('ping <@U404>', resolver({}))
    expect(out).toBe('ping <@U404>')
  })

  test('resolves a repeated mention once and rewrites every occurrence', async () => {
    let calls = 0
    const counting = async (id: string) => {
      calls++
      return id === 'U1' ? 'alice' : id
    }
    const out = await addSlackMentionHints('<@U1> and <@U1> again', counting)
    expect(out).toBe('<@U1> (alice) and <@U1> (alice) again')
    expect(calls).toBe(1)
  })

  test('normalizes Slack’s native <@id|label> form to the shared hint format', async () => {
    const out = await addSlackMentionHints('hi <@U1|legacy>', resolver({ U1: 'alice' }))
    expect(out).toBe('hi <@U1> (alice)')
  })

  test('handles W-prefixed org-account ids', async () => {
    const out = await addSlackMentionHints('<@W123ABC>', resolver({ W123ABC: 'orguser' }))
    expect(out).toBe('<@W123ABC> (orguser)')
  })

  test('supports non-Latin display names', async () => {
    const out = await addSlackMentionHints('안녕 <@U1>', resolver({ U1: '영규' }))
    expect(out).toBe('안녕 <@U1> (영규)')
  })

  test('returns text unchanged when there are no mentions', async () => {
    const out = await addSlackMentionHints('just plain text', resolver({}))
    expect(out).toBe('just plain text')
  })
})

describe('addDiscordMentionHints', () => {
  const users = (entries: Array<{ id: string; username?: string; global_name?: string | null }>) =>
    new Map(entries.map((u) => [u.id, u]))

  test('appends a display-name hint after the bare mention token', () => {
    const out = addDiscordMentionHints(
      "Yo <@123456789012345678>, what's up?",
      users([{ id: '123456789012345678', username: 'johndoe' }]),
    )
    expect(out).toBe("Yo <@123456789012345678> (johndoe), what's up?")
  })

  test('prefers global_name over username', () => {
    const out = addDiscordMentionHints('<@1>', users([{ id: '1', username: 'jdoe', global_name: 'John Doe' }]))
    expect(out).toBe('<@1> (John Doe)')
  })

  test('rewrites the nickname form <@!id> too', () => {
    const out = addDiscordMentionHints('hey <@!1>', users([{ id: '1', username: 'alice' }]))
    expect(out).toBe('hey <@!1> (alice)')
  })

  test('labels the bot’s own mention as (you)', () => {
    const out = addDiscordMentionHints('<@9> ping', users([{ id: '9', username: 'Momo' }]), { botUserId: '9' })
    expect(out).toBe('<@9> (you) ping')
  })

  test('leaves the token unchanged when the user is not in the mentions map', () => {
    const out = addDiscordMentionHints('ping <@404>', users([]))
    expect(out).toBe('ping <@404>')
  })

  test('rewrites every occurrence of a repeated mention', () => {
    const out = addDiscordMentionHints('<@1> and <@1>', users([{ id: '1', username: 'alice' }]))
    expect(out).toBe('<@1> (alice) and <@1> (alice)')
  })

  test('supports non-Latin display names', () => {
    const out = addDiscordMentionHints('안녕 <@1>', users([{ id: '1', username: 'yeongyu', global_name: '영규' }]))
    expect(out).toBe('안녕 <@1> (영규)')
  })

  test('returns text unchanged when there are no mentions', () => {
    const out = addDiscordMentionHints('just plain text', users([]))
    expect(out).toBe('just plain text')
  })
})

describe('extractMentionedUserIds', () => {
  test('slack: extracts ids, dedupes, drops legacy labels, handles W ids', () => {
    expect(extractMentionedUserIds('slack-bot', 'hi <@U1> and <@U1|old> and <@W2>')).toEqual(['U1', 'W2'])
  })

  test('slack: extracts the id regardless of surrounding non-Latin script', () => {
    expect(extractMentionedUserIds('slack-bot', '안녕하세요 <@U0TEST1A2B> 확인 부탁해요')).toEqual(['U0TEST1A2B'])
  })

  test('discord: extracts ids from both <@id> and <@!id>', () => {
    expect(extractMentionedUserIds('discord-bot', 'yo <@123> and <@!456> again <@123>')).toEqual(['123', '456'])
  })

  test('returns [] for adapters without id-token mentions', () => {
    for (const adapter of ['telegram-bot', 'github', 'line', 'kakaotalk'] as const) {
      expect(extractMentionedUserIds(adapter, 'hey @someone <@U1> <@123>')).toEqual([])
    }
  })

  test('returns [] when no mentions are present', () => {
    expect(extractMentionedUserIds('slack-bot', 'just plain text')).toEqual([])
    expect(extractMentionedUserIds('discord-bot', 'just plain text')).toEqual([])
  })
})
