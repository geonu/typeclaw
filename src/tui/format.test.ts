import { describe, expect, test } from 'bun:test'

import {
  formatCost,
  formatTimestamp,
  formatTokenCount,
  formatToolEnd,
  formatToolStart,
  formatUsageSummary,
  withTimestamp,
} from './format'

const stripAnsi = (s: string) =>
  // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI sequences from rendered output
  s.replace(/\x1b\[[0-9;]*m/g, '')

const visible = (s: string) => stripAnsi(s)

describe('formatToolStart args', () => {
  test('read shows just the path when no offset/limit', () => {
    const out = visible(formatToolStart('read', { path: '/foo/bar.ts' }))
    expect(out).toContain('read')
    expect(out).toContain('/foo/bar.ts')
    expect(out).not.toContain('"path"')
  })

  test('read renders offset and limit as a line range', () => {
    const out = visible(formatToolStart('read', { path: 'a.ts', offset: 10, limit: 5 }))
    expect(out).toContain('a.ts')
    expect(out).toContain('lines 10-14')
  })

  test('read with only offset says "from line N"', () => {
    const out = visible(formatToolStart('read', { path: 'a.ts', offset: 50 }))
    expect(out).toContain('from line 50')
  })

  test('read with only limit says "first N lines"', () => {
    const out = visible(formatToolStart('read', { path: 'a.ts', limit: 20 }))
    expect(out).toContain('first 20 lines')
  })

  test('bash shows the command, not JSON', () => {
    const out = visible(formatToolStart('bash', { command: 'ls -la /tmp' }))
    expect(out).toContain('ls -la /tmp')
    expect(out).not.toContain('"command"')
  })

  test('bash collapses internal whitespace', () => {
    const out = visible(formatToolStart('bash', { command: 'echo  foo\n  &&  echo  bar' }))
    expect(out).toContain('echo foo && echo bar')
  })

  test('grep shows quoted pattern and target path', () => {
    const out = visible(formatToolStart('grep', { pattern: 'foo', path: 'src/' }))
    expect(out).toContain('"foo" in src/')
    expect(out).not.toContain('"pattern"')
  })

  test('grep with only pattern shows just the quoted pattern', () => {
    const out = visible(formatToolStart('grep', { pattern: 'TODO' }))
    expect(out).toContain('"TODO"')
    expect(out).not.toContain(' in ')
  })

  test('edit shows path and edit count', () => {
    const out = visible(formatToolStart('edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] }))
    expect(out).toContain('a.ts')
    expect(out).toContain('1 edit')
    expect(out).not.toContain('"oldText"')
  })

  test('edit pluralizes for multiple edits', () => {
    const out = visible(
      formatToolStart('edit', {
        path: 'a.ts',
        edits: [
          { oldText: 'a', newText: 'b' },
          { oldText: 'c', newText: 'd' },
        ],
      }),
    )
    expect(out).toContain('2 edits')
  })

  test('write shows path and human byte size', () => {
    const out = visible(formatToolStart('write', { path: 'a.ts', content: 'x'.repeat(2048) }))
    expect(out).toContain('a.ts')
    expect(out).toMatch(/\b2(\.0)?KB\b/)
  })

  test('ls shows the path', () => {
    const out = visible(formatToolStart('ls', { path: '/etc' }))
    expect(out).toContain('/etc')
    expect(out).not.toContain('"path"')
  })

  test('find shows pattern and path', () => {
    const out = visible(formatToolStart('find', { pattern: '*.ts', path: 'src' }))
    expect(out).toContain('*.ts in src')
  })

  test('web_search shows quoted query', () => {
    const out = visible(formatToolStart('web_search', { query: 'lmk what' }))
    expect(out).toContain('"lmk what"')
    expect(out).not.toContain('"query"')
  })

  test('web_search shows source when not the default', () => {
    const out = visible(formatToolStart('web_search', { query: 'foo', source: 'wikipedia' }))
    expect(out).toContain('"foo" (wikipedia)')
  })

  test('web_fetch shows the url', () => {
    const out = visible(formatToolStart('web_fetch', { url: 'https://example.com/page' }))
    expect(out).toContain('https://example.com/page')
    expect(out).not.toContain('"url"')
  })

  test('unknown tool falls back to compact JSON args', () => {
    const out = visible(formatToolStart('mystery', { foo: 'bar' }))
    expect(out).toContain('mystery')
    expect(out).toContain('{"foo":"bar"}')
  })

  test('empty args produce no preview at all', () => {
    const out = visible(formatToolStart('read', {}))
    expect(out.trim()).toBe('● read')
  })
})

describe('formatToolEnd results', () => {
  test('extracts content[].text from the standard tool result shape', () => {
    const result = { content: [{ type: 'text', text: 'hello world' }], details: { meta: 1 } }
    const out = visible(formatToolEnd('read', false, result, 12))
    expect(out).toContain('hello world')
    expect(out).not.toContain('"content"')
    expect(out).not.toContain('"details"')
    expect(out).toContain('12ms')
  })

  test('joins multiple text parts with blank lines', () => {
    const result = {
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    }
    const out = visible(formatToolEnd('read', false, result, 1))
    expect(out).toMatch(/first[\s\S]+second/)
  })

  test('plain string results are rendered as-is', () => {
    const out = visible(formatToolEnd('something', false, 'just text', 5))
    expect(out).toContain('just text')
    expect(out).not.toContain('"')
  })

  test('null result produces only the header', () => {
    const out = visible(formatToolEnd('read', false, null, 1))
    expect(out.trim()).toBe('✓ read 1ms')
  })

  test('image read collapses to a placeholder, not base64', () => {
    const result = {
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', data: 'AAAAAAAAAAAAAAA==', mimeType: 'image/png' },
      ],
    }
    const out = visible(formatToolEnd('read', false, result, 8))
    expect(out).toContain('[image: image/png]')
    expect(out).not.toContain('AAAAAAAAA')
  })

  test('edit result shows the diff from details, not the raw text confirmation', () => {
    const diff = '@@ -1 +1 @@\n-old\n+new'
    const result = {
      content: [{ type: 'text', text: 'Updated 1 file' }],
      details: { diff, firstChangedLine: 1 },
    }
    const out = visible(formatToolEnd('edit', false, result, 3))
    expect(out).toContain('-old')
    expect(out).toContain('+new')
    expect(out).not.toContain('Updated 1 file')
  })

  test('bash result appends the full output path footer when present', () => {
    const result = {
      content: [{ type: 'text', text: 'first 10 lines…' }],
      details: { fullOutputPath: '/tmp/full.txt' },
    }
    const out = visible(formatToolEnd('bash', false, result, 50))
    expect(out).toContain('first 10 lines')
    expect(out).toContain('Full output saved to: /tmp/full.txt')
  })

  test('web_search reformats results into a numbered list', () => {
    const result = {
      content: [{ type: 'text', text: 'Search results for "x"…' }],
      details: {
        query: 'x',
        source: 'web',
        count: 2,
        results: [
          { title: 'First', url: 'https://a.example', snippet: 'a' },
          { title: 'Second', url: 'https://b.example', snippet: 'b' },
        ],
      },
    }
    const out = visible(formatToolEnd('web_search', false, result, 100))
    expect(out).toContain('2 results for "x" (web)')
    expect(out).toContain('1. First — https://a.example')
    expect(out).toContain('2. Second — https://b.example')
  })

  test('error result is rendered (color is applied internally)', () => {
    const result = { content: [{ type: 'text', text: 'boom' }] }
    const out = visible(formatToolEnd('bash', true, result, 7))
    expect(out).toContain('✗')
    expect(out).toContain('bash')
    expect(out).toContain('boom')
  })

  test('truncation kicks in for very long results', () => {
    const long = 'x'.repeat(5000)
    const result = { content: [{ type: 'text', text: long }] }
    const out = visible(formatToolEnd('read', false, result, 1))
    expect(out).toContain('…')
    expect(out).toContain('chars)')
    expect(out.length).toBeLessThan(long.length)
  })

  test('non-standard result shape falls back to pretty JSON', () => {
    const out = visible(formatToolEnd('mystery', false, { foo: 'bar' }, 1))
    expect(out).toContain('"foo": "bar"')
  })
})

describe('formatTimestamp', () => {
  test('renders HH:MM:SS for a real timestamp', () => {
    const ts = new Date(2026, 0, 2, 9, 5, 7).getTime()
    expect(visible(formatTimestamp(ts))).toBe('09:05:07')
  })

  test('renders the placeholder for undefined and ts=0', () => {
    expect(visible(formatTimestamp(undefined))).toBe('--:--:--')
    expect(visible(formatTimestamp(0))).toBe('--:--:--')
  })

  test('withTimestamp prefixes the body with the time', () => {
    const ts = new Date(2026, 0, 2, 23, 59, 59).getTime()
    expect(visible(withTimestamp(ts, 'hello'))).toBe('23:59:59 hello')
  })
})

describe('token and cost formatting', () => {
  test('sub-1k token counts render verbatim', () => {
    expect(formatTokenCount(999)).toBe('999')
  })

  test('thousands render with a single decimal, trailing .0 stripped', () => {
    expect(formatTokenCount(1500)).toBe('1.5k')
    expect(formatTokenCount(12300)).toBe('12.3k')
    expect(formatTokenCount(12000)).toBe('12k')
  })

  test('hundreds of thousands round to whole k', () => {
    expect(formatTokenCount(125000)).toBe('125k')
  })

  test('cost renders to four decimals', () => {
    expect(formatCost(0.0042)).toBe('$0.0042')
  })

  test('usage summary combines tokens and cost', () => {
    expect(formatUsageSummary({ totalTokens: 12300, cost: 0.0042 })).toBe('⚡ 12.3k tok · $0.0042')
  })
})
