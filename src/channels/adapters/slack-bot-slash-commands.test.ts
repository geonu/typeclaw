import { describe, expect, test } from 'bun:test'

import type { SlackSocketModeSlashCommandArgs } from 'agent-messenger/slackbot'

import {
  buildSlashAckPayload,
  commandResultReply,
  parseSlashCommand,
  parseThreadCommand,
  SLACK_SLASH_REPLY_ABORTED,
  type ThreadCommandInput,
} from './slack-bot-slash-commands'

type Body = SlackSocketModeSlashCommandArgs['body']

function body(over: Partial<Body> = {}): Body {
  return {
    command: '/stop',
    text: '',
    user_id: 'U-alice',
    channel_id: 'C-general',
    team_id: 'T-acme',
    ...over,
  }
}

describe('parseSlashCommand', () => {
  const known = new Set(['stop'])

  test('parses /stop in a public channel into a slack-bot ChannelKey', () => {
    const result = parseSlashCommand(body(), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command).toEqual({
      name: 'stop',
      key: { adapter: 'slack-bot', workspace: 'T-acme', chat: 'C-general', thread: null },
      invokerId: 'U-alice',
    })
  })

  test('maps DM channel ids (D prefix) to workspace=@dm', () => {
    const result = parseSlashCommand(body({ channel_id: 'D-bob' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.workspace).toBe('@dm')
    expect(result.command.key.chat).toBe('D-bob')
  })

  test('MPIM and private channel ids (G prefix) map to the team workspace (NOT @dm)', () => {
    const result = parseSlashCommand(body({ channel_id: 'G0MPIM' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.workspace).toBe('T-acme')
    expect(result.command.key.chat).toBe('G0MPIM')
  })

  test('lowercases the command name', () => {
    const result = parseSlashCommand(body({ command: '/STOP' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.name).toBe('stop')
  })

  test('ignores unknown command names', () => {
    const result = parseSlashCommand(body({ command: '/unknown' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'unknown-command' })
  })

  test('ignores malformed commands (no leading slash)', () => {
    const result = parseSlashCommand(body({ command: 'stop' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'malformed' })
  })

  test('ignores payloads missing user_id (defensive)', () => {
    const result = parseSlashCommand(body({ user_id: '' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-invoker' })
  })

  test('ignores payloads missing channel_id', () => {
    const result = parseSlashCommand(body({ channel_id: '' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-channel' })
  })

  test('ignores payloads missing team_id (defensive — slash commands always carry it)', () => {
    const result = parseSlashCommand(body({ team_id: '' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-team' })
  })
})

describe('parseThreadCommand', () => {
  const known = new Set(['stop'])

  function input(over: Partial<ThreadCommandInput> = {}): ThreadCommandInput {
    return {
      text: '!stop',
      channel: 'C-general',
      threadTs: '1700.0001',
      isDm: false,
      teamId: 'T-acme',
      invokerId: 'U-alice',
      ...over,
    }
  }

  test('parses !stop in a thread into a thread-targeted ChannelKey', () => {
    const result = parseThreadCommand(input(), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command).toEqual({
      name: 'stop',
      key: { adapter: 'slack-bot', workspace: 'T-acme', chat: 'C-general', thread: '1700.0001' },
      invokerId: 'U-alice',
    })
  })

  test('top-level (no thread) !stop builds a thread:null key', () => {
    const result = parseThreadCommand(input({ threadTs: null }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.thread).toBe(null)
  })

  test('DM context maps workspace to @dm', () => {
    const result = parseThreadCommand(input({ isDm: true, channel: 'D-bob' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key.workspace).toBe('@dm')
    expect(result.command.key.chat).toBe('D-bob')
  })

  test('MPIM thread commands target the team-scoped group conversation', () => {
    const result = parseThreadCommand(input({ channel: 'G0MPIM', isDm: false }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.key).toEqual({
      adapter: 'slack-bot',
      workspace: 'T-acme',
      chat: 'G0MPIM',
      thread: '1700.0001',
    })
  })

  test('lowercases the command name (!STOP)', () => {
    const result = parseThreadCommand(input({ text: '!STOP' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.name).toBe('stop')
  })

  test('accepts trailing args after the command (!stop now please)', () => {
    const result = parseThreadCommand(input({ text: '!stop now please' }), known)
    expect(result.kind).toBe('parsed')
    if (result.kind !== 'parsed') return
    expect(result.command.name).toBe('stop')
  })

  test('tolerates leading whitespace before the prefix', () => {
    const result = parseThreadCommand(input({ text: '  !stop' }), known)
    expect(result.kind).toBe('parsed')
  })

  test('ignores messages without the ! prefix', () => {
    const result = parseThreadCommand(input({ text: 'stop the turn' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'no-prefix' })
  })

  test('ignores a ! message whose first token is not a known command (!nice work)', () => {
    const result = parseThreadCommand(input({ text: '!nice work' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'unknown-command' })
  })

  test('ignores a bare ! with no token', () => {
    const result = parseThreadCommand(input({ text: '! stop' }), known)
    expect(result).toEqual({ kind: 'ignore', reason: 'unknown-command' })
  })
})

describe('buildSlashAckPayload', () => {
  test('returns an ephemeral response payload', () => {
    expect(buildSlashAckPayload('Stopped.')).toEqual({
      response_type: 'ephemeral',
      text: 'Stopped.',
    })
  })
})

describe('commandResultReply', () => {
  test('uses a handler-provided reply when present (dynamic commands like /help)', () => {
    expect(commandResultReply({ kind: 'handled', name: 'help', reply: 'Available commands:\n/help — List' })).toBe(
      'Available commands:\n/help — List',
    )
  })

  test('falls back to the static abort string when no reply is provided (/stop)', () => {
    expect(commandResultReply({ kind: 'handled', name: 'stop' })).toBe(SLACK_SLASH_REPLY_ABORTED)
  })
})
