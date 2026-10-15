import { describe, expect, it } from 'bun:test'

import { isWebexIdOfType, toRef } from './webex-id-ref'

const ROOM_ID = 'Y2lzY29zcGFyazovL3VzL1JPT00vZTM1NGY2YjAtMmMyZS0xMWYxLTlmNGYtZmI5NzVmM2ViZWZi'
const PERSON_UUID_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS8xMjM0NTY3OC0xMjM0LTEyMzQtMTIzNC0xMjM0NTY3ODkwYWI='
const PERSON_EMAIL_ID = 'Y2lzY29zcGFyazovL3VzL1BFT1BMRS9hbGljZUBleGFtcGxlLmNvbQ=='

describe('toRef', () => {
  it('returns the trailing uuid for a room id', () => {
    expect(toRef(ROOM_ID)).toBe('e354f6b0-2c2e-11f1-9f4f-fb975f3ebefb')
  })

  it('returns the email for a legacy person id', () => {
    expect(toRef(PERSON_EMAIL_ID)).toBe('alice@example.com')
  })

  it('falls open: a value already in ref form passes through unchanged', () => {
    expect(toRef('alice@example.com')).toBe('alice@example.com')
    expect(toRef('12345678-1234-1234-1234-1234567890ab')).toBe('12345678-1234-1234-1234-1234567890ab')
  })
})

describe('isWebexIdOfType', () => {
  it('matches the decoded resource type', () => {
    expect(isWebexIdOfType(ROOM_ID, 'ROOM')).toBe(true)
    expect(isWebexIdOfType(PERSON_UUID_ID, 'PEOPLE')).toBe(true)
  })

  it('refuses a cross-type match (room id is not a person)', () => {
    expect(isWebexIdOfType(ROOM_ID, 'PEOPLE')).toBe(false)
  })

  it('is false for a non-Webex value', () => {
    expect(isWebexIdOfType('alice@example.com', 'PEOPLE')).toBe(false)
  })
})
