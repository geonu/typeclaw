import { randomUUID } from 'node:crypto'

import type { GithubReviewOn } from '@/channels/schema'
import type { InboundMessage, RouteReceipt } from '@/channels/types'

import { describeError } from '../../describe-error'
import type { GithubAuthContext } from './auth'
import { GITHUB_API_BASE, githubJsonHeaders } from './auth-pat'
import { followupInstruction } from './inbound'
import {
  DEFAULT_RECONCILE_COOLDOWN_MS,
  type ReconcileCooldownStore,
  type ReconcileReplayReservation,
} from './reconcile-cooldown-store'
import type { TeamMembershipChecker } from './team-membership'

// Catches up on review work that a live webhook delivery missed. The github
// adapter only acts on deliveries it receives, so a `pull_request.opened` /
// `ready_for_review` dropped while the tunnel URL was churning (cloudflare-quick
// mints a fresh host every restart) leaves an open PR permanently un-reviewed —
// nothing wakes the bot for it again. This pass runs on every adapter start()
// (cold boot AND tunnel-driven restart) and replays the PRs that still need a
// review as synthetic inbounds through the same router path a real webhook uses.
//
// It is intentionally NOT a substitute for webhooks: it is a floor, not the
// primary path. Drift between a missed delivery and the next start() is the
// reconciliation window; webhooks remain the low-latency path when delivery
// works.

export type ReconcileOpenPrsOptions = {
  repos: readonly string[]
  reviewOn: GithubReviewOn
  selfLogin: string | null
  authType: 'pat' | 'app'
  token: (context?: GithubAuthContext) => Promise<string>
  route: (message: InboundMessage) => Promise<RouteReceipt>
  logger: { info: (m: string) => void; warn: (m: string) => void }
  // Resolves whether the bot is a member of a requested team, gating
  // team-requested reviews under review.on 'review_requested' (mirrors the
  // live webhook path's isMyTeam check in classifyReviewRequest). Omitted in
  // tests that don't exercise team requests; treated as "not a member".
  isBotInTeam?: TeamMembershipChecker
  fetchImpl?: typeof fetch
  // When provided, a PR that still needs review is replayed at most once per
  // `cooldownMs`, keyed durably by `repo#prId` so restarts don't re-trigger it.
  // Only a replay the router durably admitted keeps that cooldown; a rejected
  // or non-admitted replay releases it so the next pass retries the PR.
  // Omitted in tests that assert the raw replay decision.
  cooldownStore?: ReconcileCooldownStore
  cooldownMs?: number
  // Under review.on 'opened', only PRs created within this window are replayed.
  // Reconcile catches recently missed webhooks; without a bound, adding a repo
  // would review its entire open backlog.
  maxPrAgeMs?: number
  // Also replay PRs where the bot's standing CHANGES_REQUESTED predates the
  // current head: a push follow-up a restart killed (or whose synchronize
  // delivery was lost) is never re-sent, so the block would hold until a human
  // pings. Boot-only on purpose: a periodic tick would race a live follow-up
  // re-review still in flight for the same push.
  includeHeldReviews?: boolean
  generateReviewRoundId?: () => string
  now?: () => number
  // The pass runs detached from adapter start(), so it can outlive stop(). Once
  // cancelled it must not persist cooldowns, route, or prune for a lifecycle
  // that no longer owns the channel.
  isCancelled?: () => boolean
}

// `replayed` counts only replays the router durably admitted (accepted, or a
// duplicate of an identity it had already admitted).
export type ReconcileOutcome = { repo: string; scanned: number; replayed: number } | { repo: string; error: string }

const BOT_LOGIN_SUFFIX = '[bot]'
export const DEFAULT_RECONCILE_MAX_PR_AGE_MS = 7 * 24 * 60 * 60 * 1000

export async function reconcileOpenPrs(options: ReconcileOpenPrsOptions): Promise<ReconcileOutcome[]> {
  // `off` disables code review entirely, so there is nothing to catch up on.
  if (options.reviewOn === 'off') return []
  if (options.selfLogin === null) return []
  const fetchImpl = options.fetchImpl ?? fetch
  const selfLogin = options.selfLogin
  const decoyLogin = resolveDecoyLogin(selfLogin, options.authType)

  const outcomes: ReconcileOutcome[] = []
  for (const repo of new Set(options.repos)) {
    if (options.isCancelled?.() === true) break
    const target = parseRepo(repo)
    if (target === null) {
      outcomes.push({ repo, error: 'malformed repo slug' })
      continue
    }
    try {
      const outcome = await reconcileRepo(target, options, selfLogin, decoyLogin, fetchImpl)
      outcomes.push(outcome)
      if (outcome.replayed > 0) {
        options.logger.info(`[github] reconcile ${repo}: replayed ${outcome.replayed}/${outcome.scanned} open PR(s)`)
      }
    } catch (err) {
      const message = describeError(err)
      options.logger.warn(`[github] reconcile ${repo} failed: ${message}`)
      outcomes.push({ repo, error: message })
    }
  }
  return outcomes
}

async function reconcileRepo(
  target: RepoTarget,
  options: ReconcileOpenPrsOptions,
  selfLogin: string,
  decoyLogin: string | null,
  fetchImpl: typeof fetch,
): Promise<{ repo: string; scanned: number; replayed: number }> {
  const repo = `${target.owner}/${target.repo}`
  const token = await options.token({ repoSlug: repo })
  const prs = await fetchOpenPrs(fetchImpl, token, target)

  const cooldownStore = options.cooldownStore
  const cooldownMs = options.cooldownMs ?? DEFAULT_RECONCILE_COOLDOWN_MS
  const now = options.now ?? Date.now

  let replayed = 0
  for (const pr of prs) {
    const kind = await prReplayKind({ pr, options, target, token, selfLogin, decoyLogin, fetchImpl })
    if (kind === null) continue
    if (options.isCancelled?.() === true) return { repo, scanned: prs.length, replayed }
    let reservation: ReconcileReplayReservation | null = null
    if (cooldownStore !== undefined) {
      // Decide only from the store's serialized latest state, never from this
      // instance's cached view: another lifecycle may have released (or taken)
      // the PR's reservation since that view was read. Persisting the
      // reservation before routing means a failed write throws, so we skip the
      // route rather than replay a PR with no durable record.
      try {
        reservation = await cooldownStore.markReplayed(repo, pr.id, {
          now: now(),
          cooldownMs,
          isCancelled: options.isCancelled,
        })
      } catch (err) {
        options.logger.warn(
          `[github] reconcile ${repo}: skipping PR #${pr.number} replay, cooldown persist failed: ${describeError(
            err,
          )}`,
        )
        continue
      }
      // null: cancelled while reserving, or another attempt's reservation is
      // still cooling down in the latest persisted state.
      if (reservation === null) {
        if (options.isCancelled?.() === true) return { repo, scanned: prs.length, replayed }
        continue
      }
    }
    if (options.isCancelled?.() === true) {
      // Stopped between reserving and dispatching: the replay never launches,
      // so release this attempt's reservation — never a newer one's marker.
      await releaseReservation(options, repo, pr, reservation)
      return { repo, scanned: prs.length, replayed }
    }
    if (await replayPr(options, target, pr, kind, reservation)) replayed += 1
  }

  if (cooldownStore !== undefined && options.isCancelled?.() !== true) {
    await cooldownStore.prune(repo, new Set(prs.map((pr) => pr.id)), now())
  }
  return { repo, scanned: prs.length, replayed }
}

// Routes one PR's replay in isolation: a rejected route or a receipt that did
// not durably admit the replay releases only this PR's reservation, and the pass
// moves on to the next PR. Once routed, the receipt is awaited even if the
// adapter stops meanwhile: accepted (or duplicate of an identity the router
// already admitted) keeps the cooldown durable. A rejected local route may have
// committed its admission before failing; releasing is still safe because the
// router dedupes the retry against that admission.
async function replayPr(
  options: ReconcileOpenPrsOptions,
  target: RepoTarget,
  pr: OpenPr,
  kind: ReplayKind,
  reservation: ReconcileReplayReservation | null,
): Promise<boolean> {
  const repo = `${target.owner}/${target.repo}`
  let receipt: RouteReceipt
  try {
    receipt = await options.route(
      buildSyntheticInbound(pr, target, kind, options.generateReviewRoundId ?? randomUUID, cooldownWindow(options)),
    )
  } catch (err) {
    options.logger.warn(`[github] reconcile ${repo}: PR #${pr.number} replay failed: ${describeError(err)}`)
    await releaseReservation(options, repo, pr, reservation)
    return false
  }
  if (receipt.kind === 'accepted' || receipt.kind === 'duplicate') return true
  options.logger.info(`[github] reconcile ${repo}: PR #${pr.number} replay not admitted (${receipt.kind})`)
  await releaseReservation(options, repo, pr, reservation)
  return false
}

async function releaseReservation(
  options: ReconcileOpenPrsOptions,
  repo: string,
  pr: OpenPr,
  reservation: ReconcileReplayReservation | null,
): Promise<void> {
  if (options.cooldownStore === undefined || reservation === null) return
  try {
    await options.cooldownStore.rollbackReplay(repo, pr.id, reservation.replayId)
  } catch (err) {
    options.logger.warn(
      `[github] reconcile ${repo}: PR #${pr.number} launch cooldown NOT released, so it retries only after the cooldown expires: ${describeError(
        err,
      )}`,
    )
  }
}

type ReplayKind = 'review' | 'rereview'

async function prReplayKind(input: {
  pr: OpenPr
  options: ReconcileOpenPrsOptions
  target: RepoTarget
  token: string
  selfLogin: string
  decoyLogin: string | null
  fetchImpl: typeof fetch
}): Promise<ReplayKind | null> {
  const { pr, options, target, token, selfLogin, decoyLogin, fetchImpl } = input
  if (isSelfAuthored(pr, selfLogin, decoyLogin)) return null
  let summary: SelfReviewSummary | undefined
  const selfReviews = async (): Promise<SelfReviewSummary> =>
    (summary ??= await fetchSelfReviewSummary(fetchImpl, token, target, pr.number, selfLogin))

  // A held CHANGES_REQUESTED is the bot's own obligation whichever mode woke the
  // first review, mirroring the live synchronize follow-up. It wins over an open
  // review request (an author re-requesting after pushing fixes): only the
  // re-review replay carries the push round a fresh blocking verdict needs.
  if (options.includeHeldReviews === true) {
    const { blockingCommitId } = await selfReviews()
    if (blockingCommitId !== null && pr.headSha !== null && blockingCommitId !== pr.headSha) return 'rereview'
  }

  if (options.reviewOn === 'review_requested') {
    // Only the explicit request wakes a review under this mode. A draft can
    // still carry a request, so draft state is irrelevant here. Mirrors the
    // live path's `isMeAsUser || isMyTeam`: a direct user request, OR a team
    // request the bot is a member of.
    if (isUserReviewRequestedFromSelf(pr, selfLogin, decoyLogin)) return 'review'
    return (await isTeamReviewRequestedFromSelf(pr, target, selfLogin, options.isBotInTeam)) ? 'review' : null
  }

  // reviewOn === 'opened': a non-draft PR the bot has not yet reviewed. Draft
  // PRs wait for the ready_for_review trigger, matching the live-webhook path.
  if (pr.draft || isOlderThanReplayWindow(pr, options)) return null
  return (await selfReviews()).reviewed ? null : 'review'
}

function isOlderThanReplayWindow(pr: OpenPr, options: ReconcileOpenPrsOptions): boolean {
  const createdAt = Date.parse(pr.createdAt)
  if (Number.isNaN(createdAt)) return false
  const now = (options.now ?? Date.now)()
  return now - createdAt > (options.maxPrAgeMs ?? DEFAULT_RECONCILE_MAX_PR_AGE_MS)
}

async function isTeamReviewRequestedFromSelf(
  pr: OpenPr,
  target: RepoTarget,
  selfLogin: string,
  isBotInTeam: TeamMembershipChecker | undefined,
): Promise<boolean> {
  if (isBotInTeam === undefined || pr.requestedTeamSlugs.length === 0) return false
  for (const slug of pr.requestedTeamSlugs) {
    if (await isBotInTeam({ org: target.owner, slug, login: selfLogin })) return true
  }
  return false
}

// An interrupted reconcile replay gets no restart notice; its retry is the next
// pass after the cooldown. Keying the identity by cooldown window lets that pass
// admit afresh instead of deduping against the interrupted admission, while a
// retry within the same window (e.g. after a rejected route) still dedupes.
function cooldownWindow(options: ReconcileOpenPrsOptions): number | null {
  if (options.cooldownStore === undefined) return null
  const cooldownMs = options.cooldownMs ?? DEFAULT_RECONCILE_COOLDOWN_MS
  return Math.floor((options.now ?? Date.now)() / cooldownMs)
}

function buildSyntheticInbound(
  pr: OpenPr,
  target: RepoTarget,
  kind: ReplayKind,
  generateReviewRoundId: () => string,
  window: number | null,
): InboundMessage {
  const branchSegment = pr.headRef !== null && pr.baseRef !== null ? ` Branch: ${pr.headRef} → ${pr.baseRef}.` : ''
  const text =
    kind === 'rereview' && pr.headSha !== null
      ? `PR #${pr.number}: "${pr.title}" received new commits (now at ${pr.headSha.slice(0, 7)}) since your ` +
        `blocking review, and no re-review of them has been submitted yet. ${followupInstruction(null, true)}`
      : `@${pr.authorLogin} opened PR #${pr.number}: "${pr.title}".${branchSegment}` +
        ' Please review the changes line-by-line and post your feedback.'
  // Distinct from the live `pr-<id>-opened-<updatedAt>` and push follow-up
  // `pr-<n>-recheck-<sha>` ids: a duplicate of the very admission a restart
  // interrupted would be deduped instead of re-run. Repeated reconciles for the
  // same unchanged PR still dedupe against each other (same updatedAt).
  const windowSuffix = window === null ? '' : `-w${window}`
  const externalMessageId =
    kind === 'rereview'
      ? `pr-${pr.id}-reconcile-rereview-${pr.headSha}-${pr.updatedAt}${windowSuffix}`
      : `pr-${pr.id}-reconcile-${pr.updatedAt}${windowSuffix}`
  return {
    adapter: 'github',
    workspace: `${target.owner}/${target.repo}`,
    chat: `pr:${pr.number}`,
    thread: null,
    text,
    externalMessageId,
    // A re-review must land a fresh blocking verdict at the new head, which the
    // verdict coordinator allows over a standing CHANGES_REQUESTED only inside a
    // current-head push round, exactly like the live push follow-up's.
    ...(kind === 'rereview' && pr.headSha !== null
      ? {
          githubReviewRound: {
            kind: 'push' as const,
            roundId: generateReviewRoundId(),
            workspace: `${target.owner}/${target.repo}`,
            prNumber: pr.number,
            headSha: pr.headSha,
            carrierThread: null,
          },
        }
      : {}),
    eventKind: 'pull_request:reconcile',
    revision: pr.updatedAt,
    authorId: String(pr.authorId),
    authorName: pr.authorLogin,
    authorIsBot: pr.authorIsBot,
    isBotMention: true,
    replyToBotMessageId: null,
    mentionsOthers: false,
    replyToOtherMessageId: null,
    isDm: false,
    ts: pr.updatedAt !== '' ? Date.parse(pr.updatedAt) || 0 : 0,
  }
}

type RepoTarget = { owner: string; repo: string }

type OpenPr = {
  number: number
  id: number
  title: string
  draft: boolean
  authorLogin: string
  authorId: number
  authorIsBot: boolean
  headRef: string | null
  headSha: string | null
  baseRef: string | null
  updatedAt: string
  createdAt: string
  requestedReviewerLogins: string[]
  requestedTeamSlugs: string[]
}

function parseRepo(slug: string): RepoTarget | null {
  const [owner, repo, ...rest] = slug.trim().split('/')
  if (owner === undefined || owner === '' || repo === undefined || repo === '' || rest.length > 0) return null
  return { owner, repo }
}

async function fetchOpenPrs(fetchImpl: typeof fetch, token: string, target: RepoTarget): Promise<OpenPr[]> {
  const prs: OpenPr[] = []
  let url: string | null = `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/pulls?state=open&per_page=100`
  while (url !== null) {
    const response = await fetchImpl(url, { headers: githubJsonHeaders(token) })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`GitHub pulls ${response.status}${body !== '' ? `: ${body}` : ''}`)
    }
    const page = (await response.json().catch(() => null)) as PrRow[] | null
    if (page === null) throw new Error('GitHub pulls returned non-JSON')
    for (const row of page) {
      const parsed = parsePrRow(row)
      if (parsed !== null) prs.push(parsed)
    }
    url = nextLink(response.headers.get('link'))
  }
  return prs
}

// `blockingCommitId` is the commit of the bot's latest DECISIVE review when that
// review is CHANGES_REQUESTED. COMMENTED/PENDING never clear the block (see
// review-state.ts), and the bot's own comment replies post COMMENTED reviews at
// the new head, so only the decisive review's commit tells whether it was redone.
type SelfReviewSummary = { reviewed: boolean; blockingCommitId: string | null }

const DECISIVE_REVIEW_STATES = new Set(['CHANGES_REQUESTED', 'APPROVED', 'DISMISSED'])

async function fetchSelfReviewSummary(
  fetchImpl: typeof fetch,
  token: string,
  target: RepoTarget,
  prNumber: number,
  selfLogin: string,
): Promise<SelfReviewSummary> {
  let reviewed = false
  let lastDecisive: { state: string; commitId: string | null } | null = null
  let url: string | null =
    `${GITHUB_API_BASE}/repos/${target.owner}/${target.repo}/pulls/${prNumber}/reviews?per_page=100`
  while (url !== null) {
    const response = await fetchImpl(url, { headers: githubJsonHeaders(token) })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`GitHub reviews ${response.status}${body !== '' ? `: ${body}` : ''}`)
    }
    const page = (await response.json().catch(() => null)) as ReviewRow[] | null
    if (page === null) throw new Error('GitHub reviews returned non-JSON')
    for (const row of page) {
      const login = row.user?.login ?? null
      if (login === null) continue
      if (!isSelfLogin(login, row.user?.type === 'Bot', selfLogin)) continue
      reviewed = true
      if (typeof row.state === 'string' && DECISIVE_REVIEW_STATES.has(row.state))
        lastDecisive = { state: row.state, commitId: typeof row.commit_id === 'string' ? row.commit_id : null }
    }
    url = nextLink(response.headers.get('link'))
  }
  return {
    reviewed,
    blockingCommitId: lastDecisive?.state === 'CHANGES_REQUESTED' ? lastDecisive.commitId : null,
  }
}

function isUserReviewRequestedFromSelf(pr: OpenPr, selfLogin: string, decoyLogin: string | null): boolean {
  return pr.requestedReviewerLogins.some(
    (login) => isSelfLogin(login, login.endsWith(BOT_LOGIN_SUFFIX), selfLogin) || login === decoyLogin,
  )
}

function isSelfAuthored(pr: OpenPr, selfLogin: string, decoyLogin: string | null): boolean {
  return isSelfLogin(pr.authorLogin, pr.authorIsBot, selfLogin) || pr.authorLogin === decoyLogin
}

// Mirrors review-state.ts isSelfReviewer: a GitHub App's REST login is
// `slug[bot]`, so the `[bot]` suffix-strip comparison is gated on the actor
// actually being a Bot to avoid attributing a human who owns the bare slug.
function isSelfLogin(login: string, isBot: boolean, selfLogin: string): boolean {
  if (isBot) return normalizeBotLogin(login) === normalizeBotLogin(selfLogin)
  return login === selfLogin
}

function normalizeBotLogin(login: string): string {
  return login.endsWith(BOT_LOGIN_SUFFIX) ? login.slice(0, -BOT_LOGIN_SUFFIX.length) : login
}

// A GitHub App actor's REST login is `slug[bot]`; the decoy account an operator
// requests for App-auth reviews is the bare slug. PAT auth has no decoy.
function resolveDecoyLogin(selfLogin: string, authType: 'pat' | 'app'): string | null {
  if (authType !== 'app') return null
  if (!selfLogin.endsWith(BOT_LOGIN_SUFFIX)) return null
  const slug = selfLogin.slice(0, -BOT_LOGIN_SUFFIX.length)
  return slug !== '' ? slug : null
}

function nextLink(linkHeader: string | null): string | null {
  if (linkHeader === null) return null
  for (const part of linkHeader.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part)
    if (m !== null) return m[1] ?? null
  }
  return null
}

type PrRow = {
  number?: unknown
  id?: unknown
  title?: unknown
  draft?: unknown
  updated_at?: unknown
  created_at?: unknown
  user?: { login?: unknown; id?: unknown; type?: unknown }
  head?: { ref?: unknown; sha?: unknown }
  base?: { ref?: unknown }
  requested_reviewers?: Array<{ login?: unknown }>
  requested_teams?: Array<{ slug?: unknown }>
}

type ReviewRow = { state?: unknown; commit_id?: unknown; user?: { login?: string; type?: string } }

function parsePrRow(row: PrRow): OpenPr | null {
  const number = typeof row.number === 'number' ? row.number : null
  const id = typeof row.id === 'number' ? row.id : null
  const authorLogin = typeof row.user?.login === 'string' ? row.user.login : null
  if (number === null || id === null || authorLogin === null) return null
  return {
    number,
    id,
    title: typeof row.title === 'string' ? row.title : `#${number}`,
    draft: row.draft === true,
    authorLogin,
    authorId: typeof row.user?.id === 'number' ? row.user.id : 0,
    authorIsBot: row.user?.type === 'Bot',
    headRef: typeof row.head?.ref === 'string' ? row.head.ref : null,
    headSha: typeof row.head?.sha === 'string' ? row.head.sha : null,
    baseRef: typeof row.base?.ref === 'string' ? row.base.ref : null,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    requestedReviewerLogins: (row.requested_reviewers ?? []).flatMap((r) =>
      typeof r.login === 'string' ? [r.login] : [],
    ),
    requestedTeamSlugs: (row.requested_teams ?? []).flatMap((t) => (typeof t.slug === 'string' ? [t.slug] : [])),
  }
}
