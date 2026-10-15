import { describe, expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'

import { highlightAt, refreshableSelect, type RefreshableOption, toSelectResult } from './inspect-select'

const CANCEL: symbol = Symbol('cancel')

const opts: RefreshableOption<string>[] = [
  { value: 'a', label: 'A' },
  { value: 'b', label: 'B' },
  { value: 'c', label: 'C' },
]

describe('highlightAt', () => {
  test('returns the value at the cursor', () => {
    expect(highlightAt(opts, 1)).toBe('b')
  })

  test('falls back to the first row when the cursor is out of range', () => {
    expect(highlightAt(opts, 99)).toBe('a')
  })

  test('returns undefined for an empty list', () => {
    expect(highlightAt([], 0)).toBeUndefined()
  })
})

describe('toSelectResult', () => {
  test('a picked value maps to picked', () => {
    expect(toSelectResult('b', { refreshed: false })).toEqual({ kind: 'picked', value: 'b' })
  })

  test('the cancel symbol without refresh maps to cancelled', () => {
    expect(toSelectResult(CANCEL, { refreshed: false })).toEqual({ kind: 'cancelled' })
  })

  test('refresh wins over the cancel symbol and carries the highlight', () => {
    // The `r` abort resolves to the cancel symbol too, so `refreshed` must take
    // precedence to avoid misreading a refresh as a quit.
    expect(toSelectResult(CANCEL, { refreshed: true, highlightValue: 'c' })).toEqual({
      kind: 'refresh',
      highlightValue: 'c',
    })
  })
})

describe('refreshableSelect (live clack seam)', () => {
  function fakeTty(): { input: PassThrough; output: PassThrough } {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    Object.assign(input, { isTTY: true, setRawMode: () => input })
    return { input, output }
  }

  async function drive(
    feed: (input: PassThrough) => void,
    initialValue = 'a',
  ): Promise<ReturnType<typeof toSelectResult<string>>> {
    const { input, output } = fakeTty()
    const result = refreshableSelect<string>({
      message: 'pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' },
      ],
      initialValue,
      input,
      output,
    })
    feed(input)
    return result
  }

  test('Enter resolves to the highlighted value', async () => {
    const out = await drive((i) => setTimeout(() => i.write('\r'), 40))
    expect(out).toEqual({ kind: 'picked', value: 'a' })
  })

  test('arrow-down then r refreshes carrying the moved highlight', async () => {
    const out = await drive((i) => {
      setTimeout(() => i.write('\x1b[B'), 40)
      setTimeout(() => i.write('r'), 90)
    })
    expect(out).toEqual({ kind: 'refresh', highlightValue: 'b' })
  })

  test('Ctrl-C resolves to cancelled, not refresh', async () => {
    const out = await drive((i) => setTimeout(() => i.write('\x03'), 40))
    expect(out).toEqual({ kind: 'cancelled' })
  })
})
