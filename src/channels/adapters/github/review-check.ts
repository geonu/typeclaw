import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  type PersistedReviewCheckLease,
  REVIEW_CHECK_NAME,
  type ReviewCheckKey,
  type ReviewCheckLeaseStore,
  type ReviewCheckOutcome,
  type ReviewCheckPublisher,
  type ReviewCheckPublishResult,
  type ReviewCheckRef,
} from '@/channels/github-review-check'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'

// After a 401/403/404 the repo is skipped for this long, so a missing
// permission costs one warning per window instead of one failed call per review.
export const REVIEW_CHECK_DENIAL_TTL_MS = 60 * 60_000

const STATUS_DESCRIPTION_MAX = 140

// The check is named after the agent's GitHub identity (an App's `slug[bot]`
// login shows as `slug`), so a PR reviewed by several agents gets one check per
// agent. Before the identity is known the generic name is used.
export function reviewCheckName(selfLogin: string | null): string {
  const name = selfLogin?.replace(/\[bot\]$/i, '').trim()
  return name !== undefined && name !== '' ? name : REVIEW_CHECK_NAME
}

export function createGithubReviewCheckPublisher(deps: {
  token: (context?: GithubAuthContext) => Promise<string>
  authType: 'pat' | 'app'
  enabled: () => boolean
  checkName: () => string
  logger: { warn: (m: string) => void }
  fetchImpl?: typeof fetch
  now?: () => number
}): ReviewCheckPublisher {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const deniedUntil = new Map<string, number>()
  const rateLimitedUntil = new Map<string, number>()

  const isDenied = (repo: string): boolean => (deniedUntil.get(repo) ?? 0) > now()

  const send = async (key: ReviewCheckKey, path: string, method: string, body: unknown): Promise<SendResult> => {
    if ((rateLimitedUntil.get(key.repo) ?? 0) > now()) return { kind: 'transient' }
    let response: Response
    try {
      const token = await deps.token({ repoSlug: key.repo })
      response = await fetchImpl(`${GITHUB_API_BASE}/repos/${key.repo}${path}`, {
        method,
        headers: githubJsonHeaders(token),
        body: JSON.stringify(body),
      })
    } catch (err) {
      deps.logger.warn(`[github] review check ${method} ${path} failed for ${key.repo}: ${describeError(err)}`)
      return { kind: 'transient' }
    }
    if (response.ok) return { kind: 'ok', response }
    const text = await response.text().catch(() => '')
    // GitHub reports primary and secondary rate limits as 403 (or 429); those
    // clear on their own, so they must be retried rather than cached as denials.
    if (isRateLimited(response, text)) {
      const until = rateLimitResetAt(response, now())
      rateLimitedUntil.set(key.repo, until)
      deps.logger.warn(
        `[github] review check ${method} ${path} rate-limited for ${key.repo}; retrying after ${new Date(until).toISOString()}`,
      )
      return { kind: 'transient' }
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      deniedUntil.set(key.repo, now() + REVIEW_CHECK_DENIAL_TTL_MS)
      deps.logger.warn(
        `[github] review check skipped for ${key.repo}: GitHub returned ${response.status}. ` +
          `${permissionHint(deps.authType)} Reviews still post; set channels.github.review.check to false to silence this.`,
      )
      return { kind: 'denied' }
    }
    deps.logger.warn(`[github] review check ${method} ${path} failed for ${key.repo}: ${response.status} ${text}`)
    return { kind: 'transient' }
  }

  return {
    name: deps.checkName,

    async start(key) {
      if (!deps.enabled() || isDenied(key.repo)) return null
      if (deps.authType === 'app') {
        const result = await send(key, '/check-runs', 'POST', {
          name: deps.checkName(),
          head_sha: key.headSha,
          status: 'in_progress',
          started_at: new Date(now()).toISOString(),
          output: { title: 'Reviewing', summary: 'TypeClaw is reviewing this commit.' },
        })
        if (result.kind !== 'ok') return null
        const body = (await result.response.json().catch(() => null)) as { id?: unknown } | null
        return typeof body?.id === 'number' ? { mode: 'check-run', checkRunId: body.id } : null
      }
      const context = deps.checkName()
      const result = await send(key, `/statuses/${key.headSha}`, 'POST', {
        state: 'pending',
        context,
        description: 'TypeClaw is reviewing this commit',
      })
      return result.kind === 'ok' ? { mode: 'status', context } : null
    },

    async finish(key, ref, outcome) {
      if (ref === null && (outcome.kind !== 'verdict' || !deps.enabled() || isDenied(key.repo))) return 'published'
      const mode: ReviewCheckRef['mode'] = ref?.mode ?? (deps.authType === 'app' ? 'check-run' : 'status')
      const summary = describeOutcome(outcome)
      if (mode === 'status') {
        return publishResult(
          await send(key, `/statuses/${key.headSha}`, 'POST', {
            state: statusState(outcome),
            // A pending status is only replaced by one with the same context, so
            // finish under the name it started with (leases from before
            // per-agent names carry none and started as the generic name).
            context: ref?.mode === 'status' ? (ref.context ?? REVIEW_CHECK_NAME) : deps.checkName(),
            description: truncate(summary, STATUS_DESCRIPTION_MAX),
          }),
        )
      }
      const completion = {
        status: 'completed',
        conclusion: checkRunConclusion(outcome),
        completed_at: new Date(now()).toISOString(),
        output: { title: summary, summary },
      }
      if (ref?.mode === 'check-run') {
        return publishResult(await send(key, `/check-runs/${ref.checkRunId}`, 'PATCH', completion))
      }
      return publishResult(
        await send(key, '/check-runs', 'POST', { name: deps.checkName(), head_sha: key.headSha, ...completion }),
      )
    },
  }
}

export function reviewCheckLeasePath(agentDir: string): string {
  return join(agentDir, 'channels', 'github-review-checks.json')
}

export function createReviewCheckLeaseStore(agentDir: string): ReviewCheckLeaseStore {
  const path = reviewCheckLeasePath(agentDir)
  return {
    async load() {
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const parsed = JSON.parse(raw) as { leases?: unknown }
      return Array.isArray(parsed.leases) ? parsed.leases.filter(isPersistedLease) : []
    },
    async save(leases) {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, `${JSON.stringify({ version: 1, leases }, null, 2)}\n`)
      await rename(tmp, path)
    },
  }
}

const DEFAULT_RATE_LIMIT_BACKOFF_MS = 60_000

function isRateLimited(response: Response, text: string): boolean {
  if (response.status === 429) return true
  if (response.status !== 403) return false
  return (
    response.headers.has('retry-after') ||
    response.headers.get('x-ratelimit-remaining') === '0' ||
    /rate limit/i.test(text)
  )
}

function rateLimitResetAt(response: Response, now: number): number {
  const retryAfter = Number(response.headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000
  const reset = Number(response.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(reset) && reset * 1000 > now) return reset * 1000
  return now + DEFAULT_RATE_LIMIT_BACKOFF_MS
}

type SendResult = { kind: 'ok'; response: Response } | { kind: 'denied' } | { kind: 'transient' }

// A denial cannot be fixed by retrying, so only a transient failure keeps the
// outcome pending.
function publishResult(result: SendResult): ReviewCheckPublishResult {
  return result.kind === 'transient' ? 'retry' : 'published'
}

function checkRunConclusion(outcome: ReviewCheckOutcome): 'success' | 'failure' | 'neutral' {
  if (outcome.kind === 'failed') return 'failure'
  if (outcome.kind === 'cancelled') return 'neutral'
  if (outcome.state === 'APPROVED') return 'success'
  if (outcome.state === 'CHANGES_REQUESTED') return 'failure'
  return 'neutral'
}

// Commit statuses have no neutral state; a cancellation or comment-only review
// must not block a merge, so both map to success with an explicit description.
function statusState(outcome: ReviewCheckOutcome): 'success' | 'failure' {
  return checkRunConclusion(outcome) === 'failure' ? 'failure' : 'success'
}

function describeOutcome(outcome: ReviewCheckOutcome): string {
  if (outcome.kind === 'failed') return `Review failed: ${outcome.reason}`
  if (outcome.kind === 'cancelled') return `Not reviewed: ${outcome.reason}`
  if (outcome.state === 'APPROVED') return 'TypeClaw approved this commit'
  if (outcome.state === 'CHANGES_REQUESTED') return 'TypeClaw requested changes'
  return 'TypeClaw left review comments'
}

function permissionHint(authType: 'pat' | 'app'): string {
  return authType === 'app'
    ? 'Grant the GitHub App "Checks: Read and write" permission.'
    : 'The token needs commit status write access (classic PAT `repo:status`, or fine-grained "Commit statuses: Read and write").'
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function isPersistedLease(value: unknown): value is PersistedReviewCheckLease {
  if (typeof value !== 'object' || value === null) return false
  const lease = value as Record<string, unknown>
  const ref = lease.ref as Record<string, unknown> | undefined
  return (
    typeof lease.repo === 'string' &&
    typeof lease.pullRequest === 'number' &&
    typeof lease.headSha === 'string' &&
    typeof lease.startedAt === 'number' &&
    (lease.outcome === undefined || isOutcome(lease.outcome)) &&
    (lease.outcomeAt === undefined || typeof lease.outcomeAt === 'number') &&
    (ref === null
      ? lease.outcome !== undefined
      : typeof ref === 'object' &&
        ((ref.mode === 'status' && (ref.context === undefined || typeof ref.context === 'string')) ||
          (ref.mode === 'check-run' && typeof ref.checkRunId === 'number')))
  )
}

function isOutcome(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const outcome = value as Record<string, unknown>
  if (outcome.kind === 'verdict') {
    return outcome.state === 'APPROVED' || outcome.state === 'CHANGES_REQUESTED' || outcome.state === 'COMMENTED'
  }
  return (outcome.kind === 'failed' || outcome.kind === 'cancelled') && typeof outcome.reason === 'string'
}
