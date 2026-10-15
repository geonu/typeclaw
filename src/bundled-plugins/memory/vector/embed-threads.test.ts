import { describe, expect, test } from 'bun:test'

import { DEFAULT_MAX_EMBED_THREADS, resolveEmbedThreadCount } from './embed-threads'

describe('resolveEmbedThreadCount', () => {
  test('halves the visible core count', () => {
    expect(resolveEmbedThreadCount({ parallelism: 8, cap: 16 })).toBe(4)
    expect(resolveEmbedThreadCount({ parallelism: 6, cap: 16 })).toBe(3)
  })

  test('clamps to the cap on a many-core host', () => {
    // given: 22 cores would halve to 11
    // then: the default cap holds it down
    expect(resolveEmbedThreadCount({ parallelism: 22 })).toBe(DEFAULT_MAX_EMBED_THREADS)
    expect(resolveEmbedThreadCount({ parallelism: 22, cap: 4 })).toBe(4)
  })

  test('never returns below 1 on a single-core host', () => {
    expect(resolveEmbedThreadCount({ parallelism: 1, cap: 4 })).toBe(1)
    expect(resolveEmbedThreadCount({ parallelism: 0, cap: 4 })).toBe(1)
  })

  test('detects host parallelism when none is provided', () => {
    const n = resolveEmbedThreadCount()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(DEFAULT_MAX_EMBED_THREADS)
  })
})
