import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWindows } from '@/shared'

import {
  buildCacheDir,
  ensureDirs,
  homeRoot,
  lockfilePath,
  logfilePath,
  pidfilePath,
  registrationFilePath,
  registrationsDir,
  socketPath,
} from './paths'

let home: string
let prev: string | undefined

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'typeclaw-paths-'))
  prev = process.env.TYPECLAW_HOME
  process.env.TYPECLAW_HOME = home
})

afterEach(async () => {
  if (prev === undefined) delete process.env.TYPECLAW_HOME
  else process.env.TYPECLAW_HOME = prev
  await rm(home, { recursive: true, force: true })
})

describe('paths', () => {
  test('homeRoot honors TYPECLAW_HOME override', () => {
    expect(homeRoot()).toBe(home)
  })

  test('daemon paths reflect platform IPC and TYPECLAW_HOME storage', () => {
    if (isWindows()) expect(socketPath()).toMatch(/^\\\\\.\\pipe\\typeclaw-hostd-[a-f0-9]{32}$/)
    else expect(socketPath()).toBe(join(home, 'run', 'hostd.sock'))
    expect(pidfilePath()).toBe(join(home, 'run', 'hostd.pid'))
    expect(lockfilePath()).toBe(join(home, 'run', 'hostd.lock'))
    expect(logfilePath()).toBe(join(home, 'log', 'hostd.log'))
    expect(registrationsDir()).toBe(join(home, 'run', 'registrations'))
    expect(buildCacheDir()).toBe(join(home, 'build-cache'))
  })

  test('ensureDirs creates run/, log/, and registrations/', async () => {
    await ensureDirs()
    expect(existsSync(join(home, 'run'))).toBe(true)
    expect(existsSync(join(home, 'log'))).toBe(true)
    expect(existsSync(join(home, 'run', 'registrations'))).toBe(true)
  })

  test('registrationFilePath returns a path under registrationsDir for valid names', () => {
    expect(registrationFilePath('coder')).toBe(join(home, 'run', 'registrations', 'coder.json'))
    expect(registrationFilePath('agent-1')).toBe(join(home, 'run', 'registrations', 'agent-1.json'))
    expect(registrationFilePath('A_B.c')).toBe(join(home, 'run', 'registrations', 'A_B.c.json'))
  })

  test('registrationFilePath rejects path-traversing names', () => {
    expect(() => registrationFilePath('../etc/passwd')).toThrow(/invalid container name/)
    expect(() => registrationFilePath('a/b')).toThrow(/invalid container name/)
    expect(() => registrationFilePath('with space')).toThrow(/invalid container name/)
    expect(() => registrationFilePath('')).toThrow(/invalid container name/)
    expect(() => registrationFilePath('.hidden')).toThrow(/invalid container name/)
  })
})
