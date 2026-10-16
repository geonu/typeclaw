import { createHash } from 'node:crypto'

import { GITHUB_API_BASE, githubJsonHeaders } from '@/channels/adapters/github/auth-pat'
import type { ToolResult } from '@/plugin'

export type GitAuthCredential = { source: string; token: string }
export type GitAuthLoginResolver = (token: string) => Promise<string | null>

let loginResolverForTests: GitAuthLoginResolver | undefined

export function setGitAuthLoginResolverForTests(resolver: GitAuthLoginResolver | undefined): void {
  loginResolverForTests = resolver
}

export function createGitAuthLoginResolver(
  lookup: GitAuthLoginResolver = async (token) => {
    if (loginResolverForTests !== undefined) return await loginResolverForTests(token)
    const response = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: githubJsonHeaders(token),
      signal: AbortSignal.timeout(2_000),
      redirect: 'error',
    })
    if (!response.ok) return null
    const user: unknown = await response.json()
    return user !== null && typeof user === 'object' && 'login' in user && typeof user.login === 'string'
      ? user.login
      : null
  },
): GitAuthLoginResolver {
  const cache = new Map<string, Promise<string | null>>()
  return (token) => {
    const key = createHash('sha256').update(token).digest('hex')
    let login = cache.get(key)
    if (login === undefined) {
      // Lookup is advisory: neither network errors nor response bodies may replace
      // the git failure or expose a credential through an exception.
      login = Promise.resolve()
        .then(() => lookup(token))
        .catch(() => null)
      cache.set(key, login)
    }
    return login
  }
}

export async function appendGitAuthDiagnostic(options: {
  result: ToolResult
  credentials: readonly GitAuthCredential[]
  ghCredential?: GitAuthCredential
  push: boolean
  resolveLogin: GitAuthLoginResolver
}): Promise<void> {
  const { result } = options
  const text = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  const details = result.details
  const failed =
    (details !== null &&
      typeof details === 'object' &&
      (('error' in details && typeof details.error === 'string') ||
        ('exitCode' in details && typeof details.exitCode === 'number' && details.exitCode !== 0))) ||
    /Command (?:failed|exited) with (?:exit )?code [1-9]\d*/i.test(text)
  if (!failed) return
  // These are git/GitHub protocol errors, not natural-language intent matching.
  if (
    !/\b(?:401|403)\b|Permission to .+ denied to |Authentication failed|Invalid username or password|Resource not accessible/i.test(
      text,
    ) &&
    !(options.push && /Repository not found/i.test(text))
  )
    return

  const used = await Promise.all(
    options.credentials.map(async (credential) => ({
      source: credential.source,
      login: (await options.resolveLogin(credential.token)) ?? 'unknown',
    })),
  )
  let advice = `[github-cli-auth:gitCredential] Git used ${used.map(({ source, login }) => `${source} (login: ${login})`).join('; ')}.`
  if (options.ghCredential !== undefined) {
    const ghLogin = (await options.resolveLogin(options.ghCredential.token)) ?? 'unknown'
    if (used.some(({ login }) => login !== ghLogin)) {
      advice += ` gh for this repo would use ${options.ghCredential.source} (login: ${ghLogin}).`
    }
  }
  advice +=
    ' Operator: fix or remove the mismatched credential in secrets.json (githubCli hosts for the CLI store, github for the repo token), re-authenticate the intended host gh account if needed, then run typeclaw restart.'
  // Do not trust lookup output to be secret-free, even when provided by /user.
  for (const credential of [...options.credentials, ...(options.ghCredential ? [options.ghCredential] : [])]) {
    advice = advice.replaceAll(credential.token, '[redacted]')
  }
  result.content.push({ type: 'text', text: advice })
}
