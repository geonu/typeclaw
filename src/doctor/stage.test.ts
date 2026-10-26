import { describe, expect, test } from 'bun:test'

import { detectDoctorStage } from './stage'

describe('detectDoctorStage', () => {
  test('docker exec sees TYPECLAW_CONTAINER_NAME', () => {
    expect(detectDoctorStage('/agent', { TYPECLAW_CONTAINER_NAME: 'typeclaw-agent' })).toBe('container')
  })

  test('sandboxed bash has no container env but runs in /agent', () => {
    expect(detectDoctorStage('/agent', {})).toBe('container')
  })

  test('a host agent folder is the host stage', () => {
    expect(detectDoctorStage('/home/alice/my-agent', {})).toBe('host')
  })
})
