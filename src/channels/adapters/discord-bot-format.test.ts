import { describe, expect, test } from 'bun:test'

import { convertDiscordTables, displayWidth } from './discord-bot-format'

describe('convertDiscordTables — passthrough', () => {
  test('returns empty string for empty input', () => {
    expect(convertDiscordTables('')).toBe('')
  })

  test('leaves prose without pipes untouched', () => {
    expect(convertDiscordTables('hello world, no table here')).toBe('hello world, no table here')
  })

  test('leaves a lone pipe line untouched (no alignment row)', () => {
    expect(convertDiscordTables('a | b | c\njust prose')).toBe('a | b | c\njust prose')
  })

  test('preserves surrounding prose and blank lines around a table', () => {
    const input = ['intro line', '', '| h1 | h2 |', '|----|----|', '| a | b |', '', 'outro line'].join('\n')
    const result = convertDiscordTables(input)
    expect(result.startsWith('intro line\n\n')).toBe(true)
    expect(result.endsWith('\n\noutro line')).toBe(true)
  })
})

describe('convertDiscordTables — table conversion', () => {
  test('converts a basic table to padded inline-code rows with a bold header', () => {
    const input = [
      '| header1 | header2 | header3 |',
      '|---------|---------|---------|',
      '| r1c1    | r1c2    | r1c3    |',
      '| r2c1    | r2c2    | r2c3    |',
    ].join('\n')

    const expected = [
      '**`header1  header2  header3`**',
      '`r1c1     r1c2     r1c3   `',
      '`r2c1     r2c2     r2c3   `',
    ].join('\n')

    expect(convertDiscordTables(input)).toBe(expected)
  })

  test('pads every column to the widest cell across header and body', () => {
    const input = ['| a | name |', '|---|------|', '| x | bob |', '| yy | alice |'].join('\n')

    const result = convertDiscordTables(input)
    const lines = result.split('\n')

    expect(lines[0]!.startsWith('**`')).toBe(true)
    expect(lines[0]!.endsWith('`**')).toBe(true)
    expect(lines[1]!.startsWith('`')).toBe(true)
    expect(lines[1]!.startsWith('**')).toBe(false)

    const visibleLengths = lines.map((l) => l.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, '').length)
    expect(new Set(visibleLengths).size).toBe(1)
  })

  test('handles a header-only table (no body rows)', () => {
    const input = ['| only | head |', '|------|------|'].join('\n')
    expect(convertDiscordTables(input)).toBe('**`only  head`**')
  })

  test('tolerates missing trailing cells in a body row by padding them', () => {
    const input = ['| a | b | c |', '|---|---|---|', '| 1 | 2 |'].join('\n')
    const lines = convertDiscordTables(input).split('\n')
    const headerLen = lines[0]!.replace(/^\*\*`|`\*\*$/g, '').length
    const rowLen = lines[1]!.replace(/^`|`$/g, '').length
    expect(rowLen).toBe(headerLen)
  })

  test('works without leading/trailing pipes', () => {
    const input = ['h1 | h2', '---|---', 'a | b'].join('\n')
    const expected = ['**`h1  h2`**', '`a   b `'].join('\n')
    expect(convertDiscordTables(input)).toBe(expected)
  })
})

describe('convertDiscordTables — multiple and mixed', () => {
  test('converts multiple tables in one document', () => {
    const input = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'separator prose',
      '',
      '| c | d |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n')

    const result = convertDiscordTables(input)
    expect(result).toContain('**`a  b`**')
    expect(result).toContain('**`c  d`**')
    expect(result).toContain('separator prose')
  })
})

describe('convertDiscordTables — fenced code blocks', () => {
  test('leaves a full table inside a ``` fence unchanged', () => {
    const input = ['```', '| not | table |', '|-----|-------|', '| keep | pipes |', '```'].join('\n')
    expect(convertDiscordTables(input)).toBe(input)
  })

  test('leaves a full table inside a ~~~ fence unchanged', () => {
    const input = ['~~~', '| a | b |', '|---|---|', '| 1 | 2 |', '~~~'].join('\n')
    expect(convertDiscordTables(input)).toBe(input)
  })

  test('still converts a table that appears after a closed fence', () => {
    const input = ['```', 'code', '```', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n')
    const result = convertDiscordTables(input)
    expect(result).toContain('```\ncode\n```')
    expect(result).toContain('**`a  b`**')
    expect(result).toContain('`1  2`')
  })
})

describe('convertDiscordTables — backticks in cells', () => {
  test('wraps a row containing inline code with a longer delimiter', () => {
    const input = ['| cmd | result |', '|-----|--------|', '| bun `test` | ok |'].join('\n')
    const lines = convertDiscordTables(input).split('\n')
    expect(lines[0]!).toBe('**`cmd         result`**')
    expect(lines[1]!.startsWith('``')).toBe(true)
    expect(lines[1]!.endsWith('``')).toBe(true)
    expect(lines[1]!).toContain('bun `test`')
  })

  test('escalates the delimiter past a double-backtick run and pads', () => {
    const input = ['| a | b |', '|---|---|', '| ``x`` | y |'].join('\n')
    const row = convertDiscordTables(input).split('\n')[1]!
    expect(row.startsWith('``` ')).toBe(true)
    expect(row.endsWith(' ```')).toBe(true)
    expect(row).toContain('``x``')
  })
})

describe('displayWidth', () => {
  test('counts ASCII as one column each', () => {
    expect(displayWidth('abc')).toBe(3)
  })

  test('counts CJK ideographs as 1.7 columns each', () => {
    expect(displayWidth('김철수')).toBeCloseTo(5.1)
    expect(displayWidth('日本語')).toBeCloseTo(5.1)
  })

  test('counts emoji as 1.7 columns', () => {
    expect(displayWidth('✅')).toBeCloseTo(1.7)
  })

  test('ignores zero-width and combining marks', () => {
    expect(displayWidth('a\u0301')).toBe(1)
    expect(displayWidth('a\u200bb')).toBe(2)
  })

  test('mixes widths additively', () => {
    expect(displayWidth('a김b')).toBeCloseTo(3.7)
  })
})

describe('convertDiscordTables — wide-character alignment', () => {
  // CJK glyphs are 1.7 visual units but padding inserts whole spaces, so rows
  // can no longer be EXACTLY equal width — they are apportioned to within ~1
  // visual unit of each other (see computePads). Assert that bound, not equality.
  const visualWidth = (line: string) =>
    displayWidth(line.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, ''))

  test('aligns columns by VISUAL width, not code-unit length', () => {
    const input = ['| name | status |', '|------|--------|', '| 김철수 | ✅ ok |', '| bob | done |'].join('\n')

    const widths = convertDiscordTables(input).split('\n').map(visualWidth)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1 + 1e-9)
  })

  test('a CJK cell wider than its header still aligns the body', () => {
    const input = ['| id | n |', '|----|---|', '| 1 | 김철수 |', '| 22 | x |'].join('\n')

    const widths = convertDiscordTables(input).split('\n').map(visualWidth)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1 + 1e-9)
  })

  test('does not over-pad a CJK column the way the old 2.0 model did', () => {
    // Over-padding shows up on the LATIN cell that must catch up to the CJK
    // column max, not on the CJK cell itself (which is the max and gets no
    // padding either way). A second column forces the table to convert and gives
    // the latin "label" cell a boundary to pad against. 가나다라마 (5 Hangul) is
    // the col-0 max — 5 * 1.7 = 8.5 → "label" pads to a 9-cell slot, then the
    // 2-space separator puts column 1 at offset 11. The old 2.0 model sized that
    // column at 10, so column 1 would have started at 12; assert it is earlier.
    const input = ['| label | n |', '|-------|---|', '| 가나다라마 | x |'].join('\n')
    const header = convertDiscordTables(input).split('\n')[0]!
    const inner = header.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, '')
    const col1Start = displayWidth(inner.slice(0, inner.indexOf('n')))
    expect(col1Start).toBeLessThan(12)
  })

  test('keeps every column START aligned across rows, not just total row width', () => {
    // Matching total row width can hide a drifted column boundary: a row may
    // spend its extra space in an early column while another spends it late.
    // Distinct cell tokens let us locate each column's start and measure the
    // visual offset before it — these must agree within one cell across rows.
    const rows = [
      ['목적', '추천', '이유'],
      ['힐링 안전', 'a', '4가지 조건'],
      ['x', '나가사키', 'y'],
      ['bob', 'osaka', 'cheap'],
    ]
    const input = [
      `| ${rows[0]!.join(' | ')} |`,
      '|---|---|---|',
      ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
    ].join('\n')

    const lines = convertDiscordTables(input).split('\n')
    const strip = (line: string) => line.replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/^`|`$/g, '')

    const startOffsets = (columnIndex: number) =>
      lines.map((line, rowIndex) => {
        const inner = strip(line)
        const token = rows[rowIndex]![columnIndex]!
        const at = inner.indexOf(token)
        expect(at).toBeGreaterThanOrEqual(0)
        return displayWidth(inner.slice(0, at))
      })

    for (let c = 0; c < rows[0]!.length; c++) {
      const offsets = startOffsets(c)
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(1 + 1e-9)
    }
  })
})
