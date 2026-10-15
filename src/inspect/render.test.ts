import { describe, expect, test } from 'bun:test'

import { renderEvent, TimeGate } from './render'
import type { InspectEvent } from './types'

const PLAIN = { color: false }

function stripTime(line: string): string {
  return line.replace(/^\d{2}:\d{2}:\d{2}/, 'HH:MM:SS')
}

describe('renderEvent (plain, no color)', () => {
  test('meta event prints origin label', () => {
    const ev: InspectEvent = { cat: 'meta', ts: dateMs('15:08:42'), origin: { kind: 'tui' } }
    const out = renderEvent(ev, PLAIN)
    expect(stripTime(out)).toBe('HH:MM:SS  meta       origin: TUI')
  })

  test('user event prints single-line text', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'fix the\n  type error' }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  user       fix the type error')
  })

  test('tool start prints name and compact args', () => {
    const ev: InspectEvent = {
      cat: 'tool',
      ts: dateMs('15:08:43'),
      phase: 'start',
      toolCallId: 'c1',
      name: 'read',
      args: { path: 'src/auth.ts' },
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  tool ▸     read({"path":"src/auth.ts"})')
  })

  test('tool end prints name, ok status, and human duration', () => {
    const ev: InspectEvent = {
      cat: 'tool',
      ts: dateMs('15:08:44'),
      phase: 'end',
      toolCallId: 'c1',
      name: 'read',
      result: 'file contents here',
      isError: false,
      durationMs: 1234,
    }
    const out = stripTime(renderEvent(ev, PLAIN))
    expect(out).toBe('HH:MM:SS  tool ◂     read → ok "file contents here" (1.2s)')
  })

  test('tool end with isError uses error status', () => {
    const ev: InspectEvent = {
      cat: 'tool',
      ts: dateMs('15:08:44'),
      phase: 'end',
      toolCallId: 'c1',
      name: 'bash',
      isError: true,
      durationMs: 12,
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  tool ◂     bash → error (12ms)')
  })

  test('done event shows tokens and cost when present', () => {
    const ev: InspectEvent = {
      cat: 'done',
      ts: dateMs('15:08:45'),
      stopReason: 'end_turn',
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 150,
      cost: 0.0123,
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe(
      'HH:MM:SS  done       tokens: 100 in / 50 out · $0.0123 · stop=end_turn',
    )
  })

  test('error event prints the error message', () => {
    const ev: InspectEvent = { cat: 'error', ts: dateMs('15:08:46'), message: 'provider returned 503' }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  error      provider returned 503')
  })

  test('error event appends stopReason when present and not an abort', () => {
    const ev: InspectEvent = {
      cat: 'error',
      ts: dateMs('15:08:46'),
      message: 'provider returned 503',
      stopReason: 'error',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  error      provider returned 503 (stop=error)')
  })

  test('aborted turn renders an abort tag, not error, and omits the stop suffix', () => {
    const ev: InspectEvent = {
      cat: 'error',
      ts: dateMs('15:08:46'),
      message: 'Request was aborted.',
      stopReason: 'aborted',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  abort      Request was aborted.')
  })

  test('thinking event renders with think tag and the reasoning text', () => {
    const ev: InspectEvent = {
      cat: 'thinking',
      ts: dateMs('15:08:42'),
      text: 'I should read the file before editing it.',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  think      I should read the file before editing it.')
  })

  test('redacted thinking event shows [redacted] marker (safety-filter cut, not silence)', () => {
    const ev: InspectEvent = { cat: 'thinking', ts: dateMs('15:08:42'), text: '', redacted: true }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  think      [redacted] ')
  })

  test('thinking event respects maxTextLength truncation', () => {
    const ev: InspectEvent = { cat: 'thinking', ts: dateMs('15:08:42'), text: 'x'.repeat(500) }
    const out = renderEvent(ev, { color: false, maxTextLength: 20 })
    expect(out).toContain('…')
    expect(stripTime(out)).toBe(`HH:MM:SS  think      ${'x'.repeat(20)}…`)
  })

  test('long text is truncated with an ellipsis', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'a'.repeat(500) }
    const out = renderEvent(ev, { color: false, maxTextLength: 30 })
    expect(out).toContain('…')
    expect(stripTime(out)).toBe(`HH:MM:SS  user       ${'a'.repeat(30)}…`)
  })

  test('time anchor of 0 renders as placeholder (legacy entries without timestamp)', () => {
    const ev: InspectEvent = { cat: 'meta', ts: 0, origin: { kind: 'tui' } }
    expect(renderEvent(ev, PLAIN).startsWith('--:--:--')).toBe(true)
  })

  test('inbound engage event prints decision, channel coords, author and text', () => {
    const ev: InspectEvent = {
      cat: 'inbound',
      ts: dateMs('15:08:42'),
      adapter: 'slack',
      workspace: 'acme',
      chat: 'C12345',
      thread: null,
      authorId: 'U999',
      authorName: 'alice',
      authorIsBot: false,
      isDm: false,
      isBotMention: true,
      text: 'hey bot can you help',
      externalMessageId: 'm1',
      decision: 'engage',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe(
      'HH:MM:SS  inbound    [engage] slack:acme/C12345 alice: hey bot can you help',
    )
  })

  test('inbound webex event decodes base64 room/person ids in the coord and author fallback', () => {
    const ev: InspectEvent = {
      cat: 'inbound',
      ts: dateMs('15:08:42'),
      adapter: 'webex',
      // base64url of ciscospark://us/ROOM/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
      workspace: 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl',
      chat: 'Y2lzY29zcGFyazovL3VzL1JPT00vYWFhYWFhYWEtYmJiYi1jY2NjLWRkZGQtZWVlZWVlZWVlZWVl',
      thread: null,
      // base64url of ciscospark://us/PEOPLE/11111111-2222-3333-4444-555555555555
      authorId: 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTU',
      authorName: '',
      authorIsBot: false,
      isDm: false,
      isBotMention: true,
      text: 'hello',
      externalMessageId: 'm1',
      decision: 'engage',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe(
      'HH:MM:SS  inbound    [engage] webex:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee 11111111-2222-3333-4444-555555555555: hello',
    )
  })

  test('inbound observe shows [observe] tag', () => {
    const ev: InspectEvent = {
      cat: 'inbound',
      ts: dateMs('15:08:42'),
      adapter: 'discord',
      workspace: '9999',
      chat: '8888',
      thread: '7777',
      authorId: 'U1',
      authorName: 'bob',
      authorIsBot: false,
      isDm: false,
      isBotMention: false,
      text: 'just chatting',
      externalMessageId: 'm2',
      decision: 'observe',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe(
      'HH:MM:SS  inbound    [observe] discord:9999/8888#7777 bob: just chatting',
    )
  })

  test('inbound denied shows [denied] tag (visible silent drops)', () => {
    const ev: InspectEvent = {
      cat: 'inbound',
      ts: dateMs('15:08:42'),
      adapter: 'slack',
      workspace: 'acme',
      chat: 'C12345',
      thread: null,
      authorId: 'U_stranger',
      authorName: 'stranger',
      authorIsBot: false,
      isDm: false,
      isBotMention: true,
      text: 'who are you',
      externalMessageId: 'm3',
      decision: 'denied',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe(
      'HH:MM:SS  inbound    [denied] slack:acme/C12345 stranger: who are you',
    )
  })

  test('inbound falls back to authorId when authorName is empty', () => {
    const ev: InspectEvent = {
      cat: 'inbound',
      ts: dateMs('15:08:42'),
      adapter: 'kakaotalk',
      workspace: 'kk',
      chat: 'g1',
      thread: null,
      authorId: 'k_user_123',
      authorName: '',
      authorIsBot: false,
      isDm: false,
      isBotMention: false,
      text: 'hi',
      externalMessageId: 'm4',
      decision: 'observe',
    }
    expect(stripTime(renderEvent(ev, PLAIN))).toBe('HH:MM:SS  inbound    [observe] kakaotalk:kk/g1 k_user_123: hi')
  })
})

describe('renderEvent showTime=false (suppressed timestamp keeps column alignment)', () => {
  test('blanks the time column while leaving tag and body aligned with a shown line', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'hi' }
    const shown = renderEvent(ev, { color: false })
    const hidden = renderEvent(ev, { color: false, showTime: false })
    expect(hidden).toBe(shown.replace(/^\d{2}:\d{2}:\d{2}/, '        '))
    expect(hidden.startsWith('        ')).toBe(true)
  })
})

describe('TimeGate', () => {
  test('shows again whenever the category changes', () => {
    const gate = new TimeGate()
    expect(gate.shouldShow('user')).toBe(true)
    expect(gate.shouldShow('thinking')).toBe(true)
    expect(gate.shouldShow('thinking')).toBe(false)
    expect(gate.shouldShow('tool')).toBe(true)
    expect(gate.shouldShow('tool')).toBe(false)
    expect(gate.shouldShow('assistant')).toBe(true)
  })

  test('reset() forces the next same-category event to show its timestamp again', () => {
    const gate = new TimeGate()
    expect(gate.shouldShow('tool')).toBe(true)
    expect(gate.shouldShow('tool')).toBe(false)
    gate.reset()
    expect(gate.shouldShow('tool')).toBe(true)
  })
})

describe('renderEvent (with color)', () => {
  const ANSI_ESC = String.fromCharCode(0x1b)

  test('emits ANSI codes when color enabled', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'hi' }
    const out = renderEvent(ev, { color: true })
    expect(out.includes(ANSI_ESC)).toBe(true)
  })

  test('plain mode emits zero ANSI codes', () => {
    const ev: InspectEvent = { cat: 'user', ts: dateMs('15:08:42'), text: 'hi' }
    const out = renderEvent(ev, { color: false })
    expect(out.includes(ANSI_ESC)).toBe(false)
  })
})

function dateMs(hhmmss: string): number {
  const [h, m, s] = hhmmss.split(':').map(Number) as [number, number, number]
  const d = new Date()
  d.setHours(h, m, s, 0)
  return d.getTime()
}
