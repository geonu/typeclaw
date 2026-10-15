import { describe, expect, test } from 'bun:test'

import { effectiveEnvName, resolveSecret, secretFieldSchema } from './resolve'

describe('secretFieldSchema', () => {
  test('accepts string shorthand and normalizes to { value }', () => {
    const parsed = secretFieldSchema.parse('xoxb-abc')
    expect(parsed).toEqual({ value: 'xoxb-abc' })
  })

  test('accepts object with value only', () => {
    const parsed = secretFieldSchema.parse({ value: 'xoxb-abc' })
    expect(parsed).toEqual({ value: 'xoxb-abc' })
  })

  test('accepts object with env only', () => {
    const parsed = secretFieldSchema.parse({ env: 'MY_TOKEN' })
    expect(parsed).toEqual({ env: 'MY_TOKEN' })
  })

  test('accepts object with both value and env', () => {
    const parsed = secretFieldSchema.parse({ value: 'fallback', env: 'PREFERRED' })
    expect(parsed).toEqual({ value: 'fallback', env: 'PREFERRED' })
  })

  test('rejects empty string', () => {
    expect(() => secretFieldSchema.parse('')).toThrow()
  })

  test('rejects empty object', () => {
    expect(() => secretFieldSchema.parse({})).toThrow()
  })

  test('rejects null and arrays and numbers', () => {
    expect(() => secretFieldSchema.parse(null)).toThrow()
    expect(() => secretFieldSchema.parse([])).toThrow()
    expect(() => secretFieldSchema.parse(42)).toThrow()
  })
})

describe('resolveSecret', () => {
  test('env-wins: process.env[defaultEnv] wins over secret.value', () => {
    const r = resolveSecret({ value: 'from-file' }, 'DISCORD_BOT_TOKEN', { DISCORD_BOT_TOKEN: 'from-env' })
    expect(r).toBe('from-env')
  })

  test('explicit secret.env overrides defaultEnv', () => {
    const r = resolveSecret({ value: 'from-file', env: 'MY_CUSTOM' }, 'DISCORD_BOT_TOKEN', {
      DISCORD_BOT_TOKEN: 'wrong',
      MY_CUSTOM: 'right',
    })
    expect(r).toBe('right')
  })

  test('falls back to secret.value when env unset', () => {
    const r = resolveSecret({ value: 'from-file' }, 'DISCORD_BOT_TOKEN', {})
    expect(r).toBe('from-file')
  })

  test('empty-string env value is treated as unset', () => {
    const r = resolveSecret({ value: 'from-file' }, 'DISCORD_BOT_TOKEN', { DISCORD_BOT_TOKEN: '' })
    expect(r).toBe('from-file')
  })

  test('returns undefined when nothing resolves', () => {
    const r = resolveSecret({ env: 'NOT_SET' }, undefined, {})
    expect(r).toBeUndefined()
  })

  test('secret.env without process.env entry falls back to value (not defaultEnv)', () => {
    const r = resolveSecret({ value: 'from-file', env: 'MY_CUSTOM' }, 'DEFAULT_ENV', {
      DEFAULT_ENV: 'should-be-ignored',
    })
    expect(r).toBe('from-file')
  })

  test('no defaultEnv and no secret.env: only consults secret.value', () => {
    const r = resolveSecret({ value: 'only-value' }, undefined, { SOME_VAR: 'irrelevant' })
    expect(r).toBe('only-value')
  })
})

describe('effectiveEnvName', () => {
  test('returns explicit env when set', () => {
    expect(effectiveEnvName({ env: 'MY_TOKEN' }, 'DEFAULT_TOKEN')).toBe('MY_TOKEN')
  })

  test('returns defaultEnv when env not set', () => {
    expect(effectiveEnvName({ value: 'x' }, 'DEFAULT_TOKEN')).toBe('DEFAULT_TOKEN')
  })

  test('returns undefined when neither is set', () => {
    expect(effectiveEnvName({ value: 'x' }, undefined)).toBeUndefined()
  })

  test('does not consult process.env', () => {
    expect(effectiveEnvName({ env: 'NEVER_SET_ANYWHERE' }, 'DEFAULT')).toBe('NEVER_SET_ANYWHERE')
  })
})
