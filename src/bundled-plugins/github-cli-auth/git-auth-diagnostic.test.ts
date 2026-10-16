import { describe, expect, test } from 'bun:test'

import type { ToolResult } from '@/plugin'

import { appendGitAuthDiagnostic, createGitAuthLoginResolver } from './git-auth-diagnostic'

const credentials = [{ source: 'secrets.json#githubCli hosts (GitHub CLI store)', token: 'store_secret' }]
const ghCredential = { source: 'github repo token via GH_TOKEN', token: 'repo_secret' }

describe('git auth diagnostic', () => {
  test.each([
    'remote: Permission to acme/widgets denied to wrong-account.',
    'fatal: unable to access remote: The requested URL returned error: 403',
    'fatal: Authentication failed',
    'remote: Invalid username or password',
    'remote: Repository not found.',
    'fatal: 인증 실패 (HTTP 403)',
  ])('identifies both credential accounts after %s', async (text) => {
    const result: ToolResult = { content: [{ type: 'text', text }], details: { exitCode: 128 } }
    const resolveLogin = createGitAuthLoginResolver(async (token) =>
      token === 'store_secret' ? 'wrong-account' : 'repo-account',
    )

    await appendGitAuthDiagnostic({ result, credentials, ghCredential, push: true, resolveLogin })

    const output = JSON.stringify(result)
    expect(output).toContain('githubCli')
    expect(output).toContain('wrong-account')
    expect(output).toContain('repo-account')
    expect(output).not.toContain('store_secret')
    expect(output).not.toContain('repo_secret')
  })

  test.each([
    { text: 'Everything up-to-date', exitCode: 0 },
    { text: '403 is a branch name, push succeeded', exitCode: 0 },
    { text: '! [rejected] main -> main (non-fast-forward)', exitCode: 1 },
    { text: 'CONFLICT (content): Merge conflict in file.ts', exitCode: 1 },
  ])('leaves unrelated output unchanged: $text', async ({ text, exitCode }) => {
    const result: ToolResult = { content: [{ type: 'text', text }], details: { exitCode } }
    const original = structuredClone(result)
    let lookups = 0

    await appendGitAuthDiagnostic({
      result,
      credentials,
      ghCredential,
      push: true,
      resolveLogin: async () => {
        lookups++
        return 'unused'
      },
    })

    expect(result).toEqual(original)
    expect(lookups).toBe(0)
  })

  test('failed lookup still identifies the source without leaking its error', async () => {
    const result: ToolResult = {
      content: [{ type: 'text', text: 'Authentication failed\nCommand exited with code 128' }],
    }

    await appendGitAuthDiagnostic({
      result,
      credentials,
      push: false,
      resolveLogin: createGitAuthLoginResolver(async () => {
        throw new Error('store_secret')
      }),
    })

    expect(JSON.stringify(result)).toContain('githubCli')
    expect(JSON.stringify(result)).toContain('unknown')
    expect(JSON.stringify(result)).not.toContain('store_secret')
  })

  test('caches concurrent login lookups by token and separates rotated tokens', async () => {
    const seen: string[] = []
    const resolveLogin = createGitAuthLoginResolver(async (token) => {
      seen.push(token)
      return 'account'
    })

    await Promise.all([resolveLogin('first'), resolveLogin('first'), resolveLogin('second')])

    expect(seen).toEqual(['first', 'second'])
  })
})
