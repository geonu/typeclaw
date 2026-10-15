import { describe, expect, test } from 'bun:test'

import {
  formatCitation,
  isCitationLine,
  normalizeCitation,
  parseCitations,
  splitCitationsBySection,
  splitCitationRefsBySection,
  stripCitationLines,
} from './citations'

const ID_A = '019e2eca-6fc5-71ef-add9-67a0955a4b35'
const ID_B = '019e2ecf-f2d5-70ee-83f6-005fb5451c51'
const ID_C = '019e2ee8-bcc4-772f-8821-876162c5e601'

describe('formatCitation', () => {
  test('produces the canonical streams/yyyy-MM-dd#<id> shape', () => {
    expect(formatCitation('2026-05-16', ID_A)).toBe(`streams/2026-05-16#${ID_A}`)
  })
})

describe('isCitationLine', () => {
  test('matches a citation line with a leading dash and space', () => {
    expect(isCitationLine(`- streams/2026-05-16#${ID_A}`)).toBe(true)
  })

  test('matches a bare citation line', () => {
    expect(isCitationLine(`streams/2026-05-16#${ID_A}`)).toBe(true)
  })

  test('matches a transitional legacy citation line', () => {
    expect(isCitationLine(`memory/2026-05-16#${ID_A}`)).toBe(true)
  })

  test('rejects a legacy line-range citation', () => {
    expect(isCitationLine('- memory/2026-05-16:43-45')).toBe(false)
  })

  test('rejects an unrelated bullet line', () => {
    expect(isCitationLine('- some other content')).toBe(false)
  })
})

describe('parseCitations', () => {
  test('extracts every citation grouped by date', () => {
    const text = [
      '## Topic',
      'Conclusion paragraph.',
      '',
      'fragments:',
      `- streams/2026-05-16#${ID_A}`,
      `- streams/2026-05-16#${ID_B}`,
      `- streams/2026-05-15#${ID_C}`,
    ].join('\n')

    const result = parseCitations(text)

    expect(result.get('2026-05-16')).toEqual(new Set([ID_A, ID_B]))
    expect(result.get('2026-05-15')).toEqual(new Set([ID_C]))
  })

  test('returns an empty map when no citations appear', () => {
    expect(parseCitations('# Memory\n\n(empty)\n').size).toBe(0)
  })

  test('drops legacy :line-range citations entirely (no backward compat)', () => {
    const text = [
      '## Old topic',
      'fragments:',
      '- memory/2026-04-27:43-45',
      '',
      '## New topic',
      'fragments:',
      `- streams/2026-05-16#${ID_A}`,
    ].join('\n')

    const result = parseCitations(text)

    expect(result.has('2026-04-27')).toBe(false)
    expect(result.get('2026-05-16')).toEqual(new Set([ID_A]))
  })

  test('deduplicates repeated citations of the same fragment', () => {
    const text = [`- streams/2026-05-16#${ID_A}`, `- streams/2026-05-16#${ID_A}`].join('\n')

    const result = parseCitations(text)

    expect(result.get('2026-05-16')).toEqual(new Set([ID_A]))
  })

  test('citation can appear inline inside prose, not only as a bullet line', () => {
    const text = `see streams/2026-05-16#${ID_A} for context`

    const result = parseCitations(text)

    expect(result.get('2026-05-16')).toEqual(new Set([ID_A]))
  })

  test('new-format citations parse correctly', () => {
    const result = parseCitations(`see streams/2026-05-20#abc and streams/2026-05-21#def`)

    expect(result.get('2026-05-20')).toEqual(new Set(['abc']))
    expect(result.get('2026-05-21')).toEqual(new Set(['def']))
  })

  test('legacy-format citations still parse during migration', () => {
    const result = parseCitations(`see memory/2026-05-20#abc`)

    expect(result.get('2026-05-20')).toEqual(new Set(['abc']))
  })

  test('mixed canonical and legacy citations parse together', () => {
    const result = parseCitations('streams/2026-05-20#a, memory/2026-05-20#b, streams/2026-05-21#c')

    expect(result.get('2026-05-20')).toEqual(new Set(['a', 'b']))
    expect(result.get('2026-05-21')).toEqual(new Set(['c']))
  })
})

describe('normalizeCitation', () => {
  test('converts legacy citations and is idempotent on canonical citations', () => {
    expect(normalizeCitation('memory/2026-05-20#abc')).toBe('streams/2026-05-20#abc')
    expect(normalizeCitation('streams/2026-05-20#abc')).toBe('streams/2026-05-20#abc')
  })

  test('converts citation substrings in prose', () => {
    expect(normalizeCitation('something else memory/2026-05-20#abc more text')).toBe(
      'something else streams/2026-05-20#abc more text',
    )
  })

  test('converts multiple legacy citations in one string', () => {
    expect(normalizeCitation('memory/2026-05-20#abc and memory/2026-05-21#def')).toBe(
      'streams/2026-05-20#abc and streams/2026-05-21#def',
    )
  })
})

describe('splitCitationsBySection', () => {
  test('preserves date coordinates while routing direct section references', () => {
    const body = ['fragments:', `- streams/2026-05-16#${ID_A}`, 'superseded:', `- streams/2026-05-15#${ID_C}`].join(
      '\n',
    )

    expect(splitCitationRefsBySection(body)).toEqual({
      active: [{ date: '2026-05-16', fragmentId: ID_A }],
      superseded: [{ date: '2026-05-15', fragmentId: ID_C }],
    })
  })

  test('routes citations under fragments: to active and superseded: to superseded', () => {
    // given
    const body = [
      'User uses pnpm (switched from bun).',
      '',
      'fragments:',
      `- streams/2026-05-21#${ID_B}`,
      '',
      'superseded:',
      `- streams/2026-05-20#${ID_A}`,
    ].join('\n')

    // when
    const { active, superseded } = splitCitationsBySection(body)

    // then
    expect(active).toEqual(new Set([ID_B]))
    expect(superseded).toEqual(new Set([ID_A]))
  })

  test('treats citations before any heading as active (legacy shards)', () => {
    const body = ['Some belief.', '', `- streams/2026-05-20#${ID_A}`].join('\n')

    expect(splitCitationsBySection(body)).toEqual({ active: new Set([ID_A]), superseded: new Set() })
  })

  test('re-affirmed fact in both sections resolves to active', () => {
    const body = ['fragments:', `- streams/2026-05-22#${ID_C}`, 'superseded:', `- streams/2026-05-20#${ID_C}`].join(
      '\n',
    )

    const { active, superseded } = splitCitationsBySection(body)

    expect(active).toEqual(new Set([ID_C]))
    expect(superseded).toEqual(new Set())
  })

  test('parseCitations stays section-blind so GC still pins superseded fragments', () => {
    const body = ['fragments:', `- streams/2026-05-21#${ID_B}`, 'superseded:', `- streams/2026-05-20#${ID_A}`].join(
      '\n',
    )

    const all = parseCitations(body)

    expect(all.get('2026-05-21')).toEqual(new Set([ID_B]))
    expect(all.get('2026-05-20')).toEqual(new Set([ID_A]))
  })
})

describe('stripCitationLines', () => {
  test('removes citation lines and the fragments:/superseded: headings, keeping the belief', () => {
    const body = [
      'The user consistently uses pnpm.',
      'fragments:',
      `- streams/2026-05-21#${ID_A}`,
      `- streams/2026-05-22#${ID_B}`,
      'superseded:',
      `- streams/2026-05-20#${ID_C}`,
    ].join('\n')

    expect(stripCitationLines(body)).toBe('The user consistently uses pnpm.')
  })

  test('preserves multi-paragraph prose while collapsing the blank run left by stripping', () => {
    const body = [
      'A proposal rationale.',
      '',
      'A second paragraph.',
      '',
      'fragments:',
      `- streams/2026-05-21#${ID_A}`,
    ].join('\n')

    expect(stripCitationLines(body)).toBe('A proposal rationale.\n\nA second paragraph.')
  })

  test('returns an empty string for a citation-only body', () => {
    const body = ['fragments:', `- streams/2026-05-21#${ID_A}`].join('\n')

    expect(stripCitationLines(body)).toBe('')
  })
})
