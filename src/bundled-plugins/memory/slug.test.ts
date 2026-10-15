import { describe, expect, it } from 'bun:test'

import { headingToSlug, isValidSlug, slugIsHeadingEcho, SLUG_REGEX } from './slug'

describe('headingToSlug', () => {
  it('lowercases and replaces spaces with dashes', () => {
    expect(headingToSlug('Slack DM rituals', new Set())).toBe('slack-dm-rituals')
  })

  it('strips punctuation and lowercases', () => {
    expect(headingToSlug('User prefers TypeScript', new Set())).toBe('user-prefers-typescript')
  })

  it('transliterates diacritics via NFD normalization', () => {
    expect(headingToSlug('café résumé', new Set())).toBe('cafe-resume')
  })

  it('handles all-non-ASCII headings deterministically', () => {
    const result1 = headingToSlug('한글 메모', new Set())
    const result2 = headingToSlug('한글 메모', new Set())
    expect(result1).toBe(result2)
    expect(result1.startsWith('untitled-')).toBe(true)
  })

  it('handles empty heading with deterministic hash', () => {
    const result = headingToSlug('', new Set())
    expect(result.startsWith('untitled-')).toBe(true)
    expect(result).toHaveLength('untitled-'.length + 6)
  })

  it('handles all-stripping punctuation with deterministic hash', () => {
    const result = headingToSlug('!!!@@@###', new Set())
    expect(result.startsWith('untitled-')).toBe(true)
  })

  it('appends -2 on duplicate against existingSlugs', () => {
    expect(headingToSlug('Foo', new Set(['foo']))).toBe('foo-2')
  })

  it('increments suffix case-insensitively', () => {
    expect(headingToSlug('FOO', new Set(['foo', 'foo-2']))).toBe('foo-3')
  })

  it('truncates to max 64 chars', () => {
    const longHeading = 'a'.repeat(100)
    const result = headingToSlug(longHeading, new Set())
    expect(result.length).toBeLessThanOrEqual(64)
  })

  it('handles emoji-only headings with deterministic hash', () => {
    const result = headingToSlug('🎉🎊', new Set())
    expect(result.startsWith('untitled-')).toBe(true)
    expect(result).toHaveLength('untitled-'.length + 6)
  })
})

describe('slugIsHeadingEcho', () => {
  it('is true when the slug is the kebab echo of the heading', () => {
    expect(slugIsHeadingEcho('PR review checkout workflow', 'pr-review-checkout-workflow')).toBe(true)
  })

  it('is false when the heading carries a facet the slug dropped', () => {
    expect(
      slugIsHeadingEcho('GitHub API label management in the agent environment', 'gh-api-labels-array-syntax'),
    ).toBe(false)
  })

  it('is false for an all-CJK heading even against its own untitled fallback slug', () => {
    const fallbackSlug = headingToSlug('한글 메모', new Set())
    expect(slugIsHeadingEcho('한글 메모', fallbackSlug)).toBe(false)
  })

  it('is false for a mixed heading whose non-ASCII content normalization dropped', () => {
    // headingToSlug('한글 memo') === 'memo', dropping the Korean text
    expect(slugIsHeadingEcho('한글 memo', 'memo')).toBe(false)
  })

  it('still collapses an accented heading because diacritics transliterate, not drop', () => {
    expect(slugIsHeadingEcho('café résumé', 'cafe-resume')).toBe(true)
  })

  it('is false for an emoji-only heading against its own untitled fallback slug', () => {
    const fallbackSlug = headingToSlug('🎉🎊', new Set())
    expect(slugIsHeadingEcho('🎉🎊', fallbackSlug)).toBe(false)
  })
})

describe('SLUG_REGEX', () => {
  it('matches valid slugs', () => {
    expect(SLUG_REGEX.test('slack-dm-rituals')).toBe(true)
    expect(SLUG_REGEX.test('user-prefers-typescript')).toBe(true)
    expect(SLUG_REGEX.test('a')).toBe(true)
    expect(SLUG_REGEX.test('a1')).toBe(true)
  })

  it('rejects slugs starting with a dash', () => {
    expect(SLUG_REGEX.test('-foo')).toBe(false)
  })

  it('rejects slugs starting with a dot', () => {
    expect(SLUG_REGEX.test('.foo')).toBe(false)
  })

  it('rejects uppercase letters', () => {
    expect(SLUG_REGEX.test('Foo')).toBe(false)
  })

  it('rejects underscores', () => {
    expect(SLUG_REGEX.test('foo_bar')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(SLUG_REGEX.test('')).toBe(false)
  })

  it('rejects slugs longer than 64 chars', () => {
    expect(SLUG_REGEX.test('a'.repeat(65))).toBe(false)
  })

  it('accepts slugs of exactly 64 chars', () => {
    expect(SLUG_REGEX.test('a'.repeat(64))).toBe(true)
  })
})

describe('isValidSlug', () => {
  it('returns true for valid slugs', () => {
    expect(isValidSlug('cafe-resume')).toBe(true)
    expect(isValidSlug('untitled-123abc')).toBe(true)
  })

  it('returns false for invalid slugs', () => {
    expect(isValidSlug('-leading-dash')).toBe(false)
    expect(isValidSlug('')).toBe(false)
    expect(isValidSlug('UPPER')).toBe(false)
    expect(isValidSlug('foo_bar')).toBe(false)
  })
})
