import { describe, expect, test } from 'bun:test'

import type { ToolResult } from '@/plugin'

import { capContentParts, capToolResult } from './cap-result'

const baseOptions = {
  imageMaxBytes: 100,
  textMaxBytes: 50,
  exemptTools: new Set<string>(),
}

describe('capToolResult', () => {
  test('replaces an oversized image with a text placeholder', () => {
    const result: ToolResult = {
      content: [
        { type: 'text', text: 'Read image file [image/png]' },
        { type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) },
      ],
    }

    const stats = capToolResult('read', result, baseOptions)

    expect(stats.imagesReplaced).toBe(1)
    expect(stats.textsTruncated).toBe(0)
    expect(stats.bytesElided).toBe(500)
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Read image file [image/png]' })
    expect(result.content[1]?.type).toBe('text')
    const replacement = result.content[1] as { type: 'text'; text: string }
    expect(replacement.text).toContain('tool-result-cap')
    expect(replacement.text).toContain('image/png')
    expect(replacement.text).toContain('500')
  })

  test('leaves images at or below the threshold untouched', () => {
    const result: ToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(100) }],
    }

    const stats = capToolResult('read', result, baseOptions)

    expect(stats.imagesReplaced).toBe(0)
    expect(result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(100) })
  })

  test('truncates oversized text and appends an elision marker', () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'A'.repeat(200) }],
    }

    const stats = capToolResult('bash', result, baseOptions)

    expect(stats.imagesReplaced).toBe(0)
    expect(stats.textsTruncated).toBe(1)
    expect(stats.bytesElided).toBe(150)
    const part = result.content[0] as { type: 'text'; text: string }
    expect(part.text.startsWith('A'.repeat(50))).toBe(true)
    expect(part.text).toContain('tool-result-cap')
    expect(part.text).toContain('150')
    expect(part.text).toContain('textMaxBytes=50')
  })

  test('leaves text at or below the threshold untouched', () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'A'.repeat(50) }],
    }

    const stats = capToolResult('bash', result, baseOptions)

    expect(stats.textsTruncated).toBe(0)
    expect(result.content[0]).toEqual({ type: 'text', text: 'A'.repeat(50) })
  })

  test('caps each part independently when the result mixes media types', () => {
    const result: ToolResult = {
      content: [
        { type: 'text', text: 'short ok' },
        { type: 'text', text: 'A'.repeat(200) },
        { type: 'image', mimeType: 'image/jpeg', data: 'B'.repeat(50) },
        { type: 'image', mimeType: 'image/png', data: 'C'.repeat(500) },
      ],
    }

    const stats = capToolResult('read', result, baseOptions)

    expect(stats.textsTruncated).toBe(1)
    expect(stats.imagesReplaced).toBe(1)
    expect(stats.bytesElided).toBe(150 + 500)
    expect((result.content[0] as { text: string }).text).toBe('short ok')
    expect((result.content[1] as { text: string }).text).toContain('tool-result-cap')
    expect(result.content[2]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'B'.repeat(50) })
    expect((result.content[3] as { text: string }).text).toContain('tool-result-cap')
  })

  test('skips capping when the tool is exempt', () => {
    const result: ToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
    }

    const stats = capToolResult('read', result, {
      ...baseOptions,
      exemptTools: new Set(['read']),
    })

    expect(stats.imagesReplaced).toBe(0)
    expect(stats.bytesElided).toBe(0)
    expect(result.content[0]).toEqual({ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) })
  })

  test('does not truncate web_fetch text (self-bounded by its own strategy caps)', () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'A'.repeat(200) }],
    }

    const stats = capToolResult('web_fetch', result, baseOptions)

    expect(stats.textsTruncated).toBe(0)
    expect(stats.bytesElided).toBe(0)
    expect(result.content[0]).toEqual({ type: 'text', text: 'A'.repeat(200) })
  })

  test('still replaces oversized web_fetch image parts (binary bloat protection kept)', () => {
    const result: ToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
    }

    const stats = capToolResult('web_fetch', result, baseOptions)

    expect(stats.imagesReplaced).toBe(1)
    expect(stats.bytesElided).toBe(500)
    expect(result.content[0]?.type).toBe('text')
    expect((result.content[0] as { text: string }).text).toContain('tool-result-cap')
  })

  test('mutates the original content array in place', () => {
    const originalContent: ToolResult['content'] = [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }]
    const result: ToolResult = { content: originalContent }

    capToolResult('read', result, baseOptions)

    expect(result.content).toBe(originalContent)
    expect(originalContent[0]?.type).toBe('text')
  })

  test('returns zero stats for an empty result', () => {
    const result: ToolResult = { content: [] }

    const stats = capToolResult('read', result, baseOptions)

    expect(stats).toEqual({ imagesReplaced: 0, textsTruncated: 0, bytesElided: 0 })
  })

  test('is idempotent even when the placeholder text exceeds textMaxBytes', () => {
    const result: ToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
    }
    const tinyTextOptions = { ...baseOptions, textMaxBytes: 30 }

    const firstStats = capToolResult('read', result, tinyTextOptions)
    const afterFirst = JSON.stringify(result.content)
    const secondStats = capToolResult('read', result, tinyTextOptions)

    expect(firstStats.imagesReplaced).toBe(1)
    expect(secondStats.imagesReplaced).toBe(0)
    expect(secondStats.textsTruncated).toBe(0)
    expect(JSON.stringify(result.content)).toBe(afterFirst)
  })

  test('still caps oversized text that merely starts with the elided marker', () => {
    // Real tool output that happens to begin with the marker prefix (e.g. it
    // quotes a prior placeholder) followed by megabytes of legitimate content
    // MUST get truncated. A prefix-only idempotency check would let this
    // bypass the cap entirely. See cap-result.ts ELIDED_PLACEHOLDER_PATTERN.
    const result: ToolResult = {
      content: [{ type: 'text', text: `[tool-result-cap: quoted prior placeholder] ${'X'.repeat(500)}` }],
    }

    const stats = capToolResult('bash', result, baseOptions)

    expect(stats.textsTruncated).toBe(1)
    const part = result.content[0] as { type: 'text'; text: string }
    expect(part.text.length).toBeLessThan(500)
    expect(part.text).toContain('tool-result-cap')
  })

  test('treats exemptTools as optional and defaults to no exemption', () => {
    const result: ToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }],
    }

    const stats = capToolResult('read', result, { imageMaxBytes: 100, textMaxBytes: 50 })

    expect(stats.imagesReplaced).toBe(1)
  })
})

describe('capContentParts', () => {
  test('operates on a content array directly without a ToolResult wrapper', () => {
    const content: ToolResult['content'] = [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(500) }]

    const stats = capContentParts('read', content, baseOptions)

    expect(stats.imagesReplaced).toBe(1)
    expect(content[0]?.type).toBe('text')
  })
})
