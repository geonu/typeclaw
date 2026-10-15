import { describe, expect, test } from 'bun:test'

import { formatLocalDate, formatLocalDateTime, formatLocalWeekday, resolveLocalTimezoneName } from './local-time'

describe('formatLocalDate', () => {
  test('formats a date as YYYY-MM-DD using local calendar fields', () => {
    // given
    const d = new Date(2026, 3, 28, 1, 0, 0)
    // when
    const result = formatLocalDate(d)
    // then
    expect(result).toBe('2026-04-28')
  })

  test('zero-pads month and day', () => {
    const d = new Date(2026, 0, 5, 12, 0, 0)
    expect(formatLocalDate(d)).toBe('2026-01-05')
  })

  test('uses today by default', () => {
    const result = formatLocalDate()
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const now = new Date()
    expect(result).toBe(
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
    )
  })
})

describe('formatLocalDateTime', () => {
  test('formats a date as YYYY-MM-DDTHH:mm:ss±HH:mm using local fields', () => {
    const d = new Date(2026, 3, 28, 13, 7, 9)
    const result = formatLocalDateTime(d)
    expect(result).toMatch(/^2026-04-28T13:07:09[+-]\d{2}:\d{2}$/)
  })

  test('the timezone offset reflects the local zone, not UTC', () => {
    const d = new Date(2026, 3, 28, 13, 7, 9)
    const result = formatLocalDateTime(d)
    const offsetPart = result.slice(-6)
    const expectedOffsetMinutes = -d.getTimezoneOffset()
    const sign = expectedOffsetMinutes >= 0 ? '+' : '-'
    const abs = Math.abs(expectedOffsetMinutes)
    const expected = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
    expect(offsetPart).toBe(expected)
  })
})

describe('formatLocalWeekday', () => {
  test('returns the English name for every day of the week', () => {
    const englishDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(2026, 0, 4 + dow, 12, 0, 0)
      expect(d.getDay()).toBe(dow)
      expect(formatLocalWeekday(d)).toBe(englishDays[dow]!)
    }
  })
})

describe('resolveLocalTimezoneName', () => {
  test('the returned zone name matches what Intl.DateTimeFormat reports for the same process', () => {
    expect(resolveLocalTimezoneName()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})
