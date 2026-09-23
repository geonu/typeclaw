import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createOAuthInteraction, makeFakeOAuthLoginRunner, makeOAuthLoginRunner } from './oauth-login'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'typeclaw-oauth-'))
})
afterEach(async () => rm(root, { recursive: true, force: true }))

describe('OAuth login runner', () => {
  test('reports provider selected by the model ref', async () => {
    const calls: string[] = []
    const result = await makeFakeOAuthLoginRunner({ onCalled: ({ providerId }) => calls.push(providerId) })({
      cwd: root,
      model: 'openai-codex/gpt-5.5',
    })
    expect(result).toEqual({ ok: true })
    expect(calls).toEqual(['openai-codex'])
  })

  test('rejects an API-key-only provider before login', async () => {
    const result = await makeOAuthLoginRunner({ onAuth: () => {}, onPrompt: async () => null })({
      cwd: root,
      model: 'openai/gpt-5.4-nano',
    })
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('does not support OAuth') })
  })
  test('forwards manual-code input only when provided', async () => {
    const supplied = createOAuthInteraction({
      onAuth: () => {},
      onPrompt: async () => 'fallback',
      onManualCodeInput: async () => 'manual',
    })
    expect(await supplied.prompt({ type: 'manual_code', message: 'paste' })).toBe('manual')
    const absent = createOAuthInteraction({ onAuth: () => {}, onPrompt: async () => 'fallback' })
    expect(await absent.prompt({ type: 'manual_code', message: 'paste' })).toBe('fallback')
  })

  test('passes a configured fake failure through unchanged', async () => {
    const result = await makeFakeOAuthLoginRunner({ result: { ok: false, reason: 'cancelled' } })({
      cwd: root,
      model: 'openai-codex/gpt-5.5',
    })
    expect(result).toEqual({ ok: false, reason: 'cancelled' })
  })
})
